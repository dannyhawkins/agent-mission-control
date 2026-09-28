/**
 * Mission control MCP server. Two tools:
 *   request_decision: park a question on the operator's board and block until answered.
 *   report_status:    one-line narration shown on the session's station.
 *
 * Talks to the hub over plain HTTP long-polling. No WebSocket on this side:
 * one fetch at a time, no reconnect logic, and the decision id is the only
 * state, so it even survives a hub restart mid-wait.
 *
 * The tool handlers live on a client object (createMcpClient) so tests can
 * drive them against a fake hub without a stdio transport; index.ts is the
 * stdio entry that `amc mcp` runs.
 *
 * Future: Claude Code "channels" (research preview) let a server declare
 * capabilities.experimental["claude/channel"] and receive permission prompts as
 * notifications. createServer() is the one place to add that; nothing else
 * here would change.
 */
import type { DecisionRequest, DecisionWaitResponse } from "@amc/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatAnswer } from "./format";

export interface McpContext {
  hubUrl: string;
  /** Claude Code (2.1.280 observed) exports CLAUDE_CODE_SESSION_ID to stdio MCP servers. */
  sessionId?: string;
  cwd: string;
  /** Fallback correlation: this process descends from `claude`, whose pid hooks report. */
  ancestorPids: number[];
  /** Long-poll length per /wait call. */
  waitMs?: number;
  /** Base delay between transport retries (multiplied by the attempt number). */
  retryDelayMs?: number;
  /** Server version reported in the MCP handshake. */
  version?: string;
}

const MAX_TRANSPORT_RETRIES = 3;

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: t }],
  ...(isError ? { isError } : {}),
});

/** The slice of the SDK's RequestHandlerExtra the handlers use. */
export interface ToolExtra {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification(n: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; message?: string };
  }): Promise<void>;
}

export interface DecisionArgs {
  question: string;
  options: { label: string; description?: string; recommended?: boolean }[];
  context?: string;
  urgency: "low" | "normal" | "high" | "critical";
  allow_free_text: boolean;
}

export const OFFLINE_MSG =
  "Mission control is not running (could not reach the hub). Ask the user directly in chat instead.";

export const IGNORED_MSG =
  "Mission control isn't tracking this session (its directory is on the hub's ignore list). Ask the user directly in chat instead.";

export function createMcpClient(ctx: McpContext) {
  const hub = ctx.hubUrl.replace(/\/$/, "");
  const waitMs = ctx.waitMs ?? 25_000;
  const retryDelayMs = ctx.retryDelayMs ?? 1_000;
  const { sessionId, cwd, ancestorPids } = ctx;
  const inflight = new Set<string>();

  async function hubFetch(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const { timeoutMs = 5_000, signal, ...rest } = init;
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    return fetch(hub + path, {
      ...rest,
      headers: { "content-type": "application/json", ...(rest.headers ?? {}) },
      signal: AbortSignal.any(signals),
    });
  }

  async function cancelDecision(id: string) {
    inflight.delete(id);
    try {
      await hubFetch(`/api/decisions/${id}/cancel`, { method: "POST", timeoutMs: 2_000 });
    } catch {
      // hub gone; nothing to clean up
    }
  }

  async function requestDecision(args: DecisionArgs, extra: ToolExtra): Promise<ToolResult> {
    if (args.options.length < 2 && !args.allow_free_text) {
      return text("request_decision needs at least 2 options, or allow_free_text: true.", true);
    }
    const body: DecisionRequest = {
      sessionId,
      ancestorPids,
      cwd,
      source: "mcp",
      question: args.question,
      options: args.options,
      context: args.context,
      urgency: args.urgency,
      allowFreeText: args.allow_free_text,
    };

    let id: string;
    try {
      const res = await hubFetch("/api/decisions", { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) {
        const detail = await res.text();
        // 409 + ignored: this session's directory is on the hub's ignore list.
        if (res.status === 409 && detail.includes('"ignored":true')) return text(IGNORED_MSG, true);
        return text(`Mission control rejected the decision (${res.status}): ${detail}`, true);
      }
      id = ((await res.json()) as { id: string }).id;
    } catch {
      return text(OFFLINE_MSG, true);
    }
    inflight.add(id);

    // Claude Code cancels the tool call (timeout or user abort) via extra.signal.
    const onAbort = () => void cancelDecision(id);
    extra.signal.addEventListener("abort", onAbort, { once: true });

    // Claude Code aborts a call that is silent for CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT
    // (30 min on stdio). A progress notification per poll keeps it alive.
    const progressToken = extra._meta?.progressToken;
    let polls = 0;
    const heartbeat = async () => {
      if (progressToken === undefined) return;
      try {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: ++polls, message: "waiting for the operator" },
        });
      } catch {
        // transport closed; the abort signal will follow
      }
    };

    let transportFailures = 0;
    try {
      while (!extra.signal.aborted) {
        let result: DecisionWaitResponse;
        try {
          const res = await hubFetch(`/api/decisions/${id}/wait?timeoutMs=${waitMs}`, {
            timeoutMs: waitMs + 10_000,
            signal: extra.signal,
          });
          if (res.status === 404) {
            inflight.delete(id);
            return text(
              "Mission control forgot this decision (hub restarted with a fresh database). Ask in chat instead.",
              true,
            );
          }
          result = (await res.json()) as DecisionWaitResponse;
          transportFailures = 0;
        } catch (err) {
          if (extra.signal.aborted) break;
          if (++transportFailures > MAX_TRANSPORT_RETRIES) {
            inflight.delete(id);
            return text(
              `Lost contact with mission control while waiting (${String(err)}). Ask in chat instead.`,
              true,
            );
          }
          await Bun.sleep(retryDelayMs * transportFailures);
          continue;
        }
        const recommended = args.options.find((o) => o.recommended)?.label;
        switch (result.status) {
          case "pending":
            await heartbeat();
            continue;
          case "answered":
            inflight.delete(id);
            return text(formatAnswer(args.options, result.answer, result.note));
          case "expired":
            inflight.delete(id);
            return text(
              `The decision expired with no answer from the operator. Do not guess: stop and summarise the open question in your reply${
                recommended ? ` (your recommendation was "${recommended}")` : ""
              }.`,
            );
          case "cancelled":
            inflight.delete(id);
            return text(
              "The operator cancelled this decision. Stop and summarise the open question in your reply.",
            );
        }
      }
      return text("Decision request was aborted.", true);
    } finally {
      extra.signal.removeEventListener("abort", onAbort);
    }
  }

  async function reportStatus(line: string, timeoutMs?: number): Promise<ToolResult> {
    try {
      await hubFetch("/api/status", {
        method: "POST",
        body: JSON.stringify({ sessionId, ancestorPids, cwd, line }),
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      return text("ok");
    } catch {
      return text(OFFLINE_MSG, true);
    }
  }

  return {
    requestDecision,
    reportStatus,
    /** Decision ids still waiting; cancelled on shutdown so their cards do not linger. */
    inflight: () => [...inflight],
    cancelAll: () => Promise.all([...inflight].map(cancelDecision)).then(() => undefined),
  };
}

export type McpClient = ReturnType<typeof createMcpClient>;

export function createServer(client: McpClient, version = "0.0.0"): McpServer {
  const server = new McpServer({ name: "agent-mission-control", version });

  server.registerTool(
    "request_decision",
    {
      title: "Ask the operator to decide",
      description:
        "Park a decision on the human operator's mission control board and wait for their answer. " +
        "Use it for genuine forks: architecture choices, destructive or irreversible actions, ambiguous requirements, " +
        "anything the user would want a say in. Always give context and mark a recommended option. " +
        "Blocks until answered; returns DECISION: <label>, or DECISION (typed by the user): <text> when the operator wrote their own reply, plus an optional NOTE. The user reads the card on a dashboard, not your terminal: write the question so it makes sense on its own (what you found and why it matters), and put the consequence of each choice in the option description.",
      inputSchema: z.object({
        question: z
          .string()
          .min(1)
          .max(500)
          .describe("The decision, phrased as one clear question."),
        options: z
          .array(
            z.object({
              label: z.string().min(1).max(80).describe("Short button label, e.g. 'Use Postgres'."),
              description: z
                .string()
                .max(400)
                .optional()
                .describe("Consequence or trade-off of this option."),
              recommended: z
                .boolean()
                .optional()
                .describe("Mark exactly one option as your recommendation."),
            }),
          )
          .max(6)
          .default([])
          .describe("2 to 6 options. May be empty only when allow_free_text is true."),
        context: z
          .string()
          .max(4000)
          .optional()
          .describe(
            "What you are doing, why you are asking, relevant file paths or snippets. Strongly encouraged.",
          ),
        urgency: z.enum(["low", "normal", "high", "critical"]).default("normal"),
        allow_free_text: z
          .boolean()
          .default(false)
          .describe(
            "Ignored: the operator can always type their own answer. Kept for older callers; true still allows fewer than 2 options.",
          ),
      }),
    },
    (args, extra) => client.requestDecision(args, extra as unknown as ToolExtra),
  );

  server.registerTool(
    "report_status",
    {
      title: "Narrate what you are doing",
      description:
        "Post a one-line status to the operator's mission control board (e.g. 'Refactoring auth middleware'). " +
        "Cheap and optional; use at the start of a sizeable chunk of work.",
      inputSchema: z.object({ line: z.string().min(1).max(200) }),
    },
    ({ line }) => client.reportStatus(line),
  );

  return server;
}
