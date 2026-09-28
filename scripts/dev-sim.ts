#!/usr/bin/env bun
/**
 * Pretends to be three Claude Code sessions so the UI can be demoed without
 * real ones. Talks to the hub exactly as hooks and the MCP server would.
 *
 *   bun scripts/dev-sim.ts [--once]     (AMC_HUB_URL to point elsewhere)
 *
 * alpha:   works forever, streams tool events and OTLP token metrics
 * bravo:   asks a decision via the real MCP flow and waits for you to answer it
 * charlie: hits a permission prompt, then goes idle
 *
 * --once exits shortly after the decision is answered; otherwise runs until Ctrl-C.
 */
import {
  DEFAULT_HUB_URL,
  type DecisionRequest,
  type DecisionWaitResponse,
} from "../packages/shared/src/index";

const HUB = (process.env.AMC_HUB_URL ?? DEFAULT_HUB_URL).replace(/\/$/, "");
const ONCE = process.argv.includes("--once");

interface Sim {
  name: string;
  sessionId: string;
  pid: number;
  cwd: string;
}

const SIMS: Sim[] = [
  { name: "alpha", sessionId: "sim-alpha", pid: 910001, cwd: "/Users/sim/code/alpha-api" },
  { name: "bravo", sessionId: "sim-bravo", pid: 910002, cwd: "/Users/sim/code/bravo-web" },
  { name: "charlie", sessionId: "sim-charlie", pid: 910003, cwd: "/Users/sim/code/charlie-infra" },
];

const TOOLS = ["Read", "Grep", "Edit", "Bash", "Glob", "Write", "mcp__github__list_pull_requests"];
const sleep = (ms: number) => Bun.sleep(ms);
let stopping = false;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(HUB + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

function hook(sim: Sim, event: string, extra: Record<string, unknown> = {}) {
  return post(
    `/api/hooks/${event}`,
    {
      session_id: sim.sessionId,
      transcript_path: `/Users/sim/.claude/projects/${sim.name}/transcript.jsonl`,
      cwd: sim.cwd,
      hook_event_name: event,
      ...extra,
    },
    { "x-claude-pid": String(sim.pid) },
  );
}

async function toolCall(sim: Sim, tool: string, ms = 400) {
  const input =
    tool === "Bash" ? { command: "bun test" } : { file_path: `${sim.cwd}/src/index.ts` };
  await hook(sim, "PreToolUse", { tool_name: tool, tool_input: input });
  await sleep(ms);
  await hook(sim, "PostToolUse", {
    tool_name: tool,
    tool_input: input,
    tool_response: { ok: true },
  });
}

function otlpMetrics(sim: Sim, input: number, output: number, cost: number) {
  const attr = (key: string, stringValue: string) => ({ key, value: { stringValue } });
  const sid = attr("session.id", sim.sessionId);
  return post("/v1/metrics", {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.token.usage",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    { asInt: String(input), attributes: [sid, attr("type", "input")] },
                    { asInt: String(output), attributes: [sid, attr("type", "output")] },
                  ],
                },
              },
              {
                name: "claude_code.cost.usage",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [{ asDouble: cost, attributes: [sid] }],
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

function otlpApiRequest(sim: Sim, model: string) {
  const attr = (key: string, stringValue: string) => ({ key, value: { stringValue } });
  return post("/v1/logs", {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: [
                  attr("event.name", "claude_code.api_request"),
                  attr("session.id", sim.sessionId),
                  attr("model", model),
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

async function runAlpha(sim: Sim) {
  await hook(sim, "UserPromptSubmit", { prompt: "Add rate limiting to the orders endpoint" });
  await otlpApiRequest(sim, "claude-fable-5-1");
  let i = 0;
  while (!stopping) {
    await toolCall(sim, TOOLS[i % TOOLS.length] as string, 300 + Math.random() * 900);
    if (i % 4 === 0)
      await otlpMetrics(
        sim,
        800 + Math.floor(Math.random() * 2000),
        150 + Math.floor(Math.random() * 400),
        0.02,
      );
    if (i % 12 === 11) {
      await hook(sim, "Stop");
      await sleep(4000);
      await hook(sim, "UserPromptSubmit", { prompt: "continue" });
    }
    i++;
  }
}

async function runBravo(sim: Sim) {
  await sleep(1500);
  await hook(sim, "UserPromptSubmit", {
    prompt: "Set up persistence for the new notifications service",
  });
  await otlpApiRequest(sim, "claude-opus-5-5");
  for (const tool of ["Read", "Glob", "Grep"]) await toolCall(sim, tool);

  // The real MCP path: POST the decision with our ancestor pids, then long-poll.
  const req: DecisionRequest = {
    ancestorPids: [sim.pid, 1],
    cwd: sim.cwd,
    source: "mcp",
    question: "Which datastore for the notifications service?",
    options: [
      {
        label: "Postgres",
        description: "Reuse the existing cluster; one more schema.",
        recommended: true,
      },
      { label: "SQLite", description: "Zero ops, but no shared access from the workers." },
      { label: "DynamoDB", description: "Fits the access pattern, adds a new vendor." },
    ],
    context:
      "Service handles ~50 writes/s, read by 3 worker pods. Existing Postgres cluster has headroom. Nothing in the codebase talks to Dynamo today.",
    urgency: "high",
    allowFreeText: true,
  };
  const { id } = (await post("/api/decisions", req)) as { id: string };
  console.log(`[bravo] decision ${id} waiting for you at ${HUB}`);
  let result: DecisionWaitResponse = { status: "pending" };
  while (!stopping && result.status === "pending") {
    const res = await fetch(`${HUB}/api/decisions/${id}/wait?timeoutMs=25000`);
    result = (await res.json()) as DecisionWaitResponse;
  }
  console.log(`[bravo] decision resolved: ${JSON.stringify(result)}`);
  if (result.status !== "answered") return;

  for (const tool of ["Write", "Edit", "Bash"]) await toolCall(sim, tool, 600);
  await otlpMetrics(sim, 5200, 900, 0.11);
  await hook(sim, "Stop");
  if (ONCE) {
    await sleep(3000);
    stopping = true;
  }
}

async function runCharlie(sim: Sim) {
  await sleep(3000);
  await hook(sim, "UserPromptSubmit", { prompt: "Rotate the staging DB credentials" });
  await otlpApiRequest(sim, "claude-sonnet-5");
  for (const tool of ["Read", "Grep"]) await toolCall(sim, tool);
  await hook(sim, "PreToolUse", {
    tool_name: "Bash",
    tool_input: { command: "terraform apply -auto-approve" },
  });
  await hook(sim, "PermissionRequest", {
    tool_name: "Bash",
    tool_input: { command: "terraform apply -auto-approve" },
  });
  await sleep(6000);
  await hook(sim, "Notification", {
    notification_type: "permission_prompt",
    message: "Claude needs your permission to use Bash",
  });
  console.log("[charlie] stuck on a permission prompt (resolves itself in 45s)");
  await sleep(39_000);
  if (stopping) return;
  await hook(sim, "PostToolUse", {
    tool_name: "Bash",
    tool_input: { command: "terraform apply -auto-approve" },
    tool_response: {},
  });
  await toolCall(sim, "Edit");
  await hook(sim, "Stop");
  await sleep(2000);
  await hook(sim, "Notification", {
    notification_type: "idle_prompt",
    message: "Claude is waiting for your input",
  });
}

async function main() {
  try {
    await fetch(`${HUB}/api/health`);
  } catch {
    console.error(`hub not reachable at ${HUB}. Start it with: task dev:hub`);
    process.exit(1);
  }
  for (const sim of SIMS) await hook(sim, "SessionStart", { source: "startup" });
  console.log(
    `[sim] 3 sessions started against ${HUB}${ONCE ? " (--once)" : " (Ctrl-C to end them)"}`,
  );

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    for (const sim of SIMS) await hook(sim, "SessionEnd", { reason: "exit" }).catch(() => {});
    console.log("[sim] sessions ended");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await Promise.all([
    runAlpha(SIMS[0] as Sim),
    runBravo(SIMS[1] as Sim),
    runCharlie(SIMS[2] as Sim),
  ]);
  await shutdown();
}

await main();
