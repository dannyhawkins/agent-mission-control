import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { collectAncestorPids } from "./index";
import {
  createMcpClient,
  createServer,
  type DecisionArgs,
  IGNORED_MSG,
  OFFLINE_MSG,
  type ToolExtra,
} from "./server";

/**
 * A fake hub: POST /api/decisions answers `create`, each /wait pops the next
 * scripted reply (default: pending). Records every request.
 */
function fakeHub(script: { create?: () => Response; waits?: (() => Response)[] }) {
  const seen: { method: string; path: string; body?: unknown }[] = [];
  const waits = [...(script.waits ?? [])];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.json().catch(() => undefined) : undefined;
      seen.push({ method: req.method, path: url.pathname + url.search, body });
      if (url.pathname === "/api/decisions") {
        return script.create?.() ?? Response.json({ id: "d1" });
      }
      if (url.pathname.endsWith("/wait")) {
        return (waits.shift() ?? (() => Response.json({ status: "pending" })))();
      }
      return Response.json({ ok: true });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function extra(progressToken?: string) {
  const ac = new AbortController();
  const progress: number[] = [];
  const e: ToolExtra = {
    signal: ac.signal,
    ...(progressToken ? { _meta: { progressToken } } : {}),
    sendNotification: async (n) => void progress.push(n.params.progress),
  };
  return { e, ac, progress };
}

const ARGS: DecisionArgs = {
  question: "Which database?",
  options: [
    { label: "Postgres", recommended: true },
    { label: "SQLite", description: "simpler" },
  ],
  context: "setting up storage",
  urgency: "normal",
  allow_free_text: false,
};

const client = (hubUrl: string) =>
  createMcpClient({
    hubUrl: `${hubUrl}/`,
    sessionId: "s1",
    cwd: "/work/proj",
    ancestorPids: [123],
    waitMs: 50,
    retryDelayMs: 1,
  });

const textOf = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("");

describe("request_decision", () => {
  test("answered with an option label, after pending polls that send progress", async () => {
    const hub = fakeHub({
      waits: [
        () => Response.json({ status: "pending" }),
        () => Response.json({ status: "answered", answer: "Postgres", note: "go" }),
      ],
    });
    const { e, progress } = extra("tok");
    const r = await client(hub.url).requestDecision(ARGS, e);
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toBe("DECISION: Postgres\nNOTE: go");
    expect(progress).toEqual([1]);
    const post = hub.seen[0];
    expect(post?.path).toBe("/api/decisions");
    expect(post?.body).toMatchObject({
      sessionId: "s1",
      ancestorPids: [123],
      cwd: "/work/proj",
      source: "mcp",
      question: "Which database?",
      allowFreeText: false,
    });
    expect(hub.seen[1]?.path).toBe("/api/decisions/d1/wait?timeoutMs=50");
  });

  test("a typed answer is flagged as the user's own words", async () => {
    const hub = fakeHub({
      waits: [() => Response.json({ status: "answered", answer: "Use DuckDB instead" })],
    });
    const r = await client(hub.url).requestDecision(ARGS, extra().e);
    expect(textOf(r)).toBe("DECISION (typed by the user): Use DuckDB instead");
  });

  test("expired: do not guess, and the recommendation is repeated", async () => {
    const hub = fakeHub({ waits: [() => Response.json({ status: "expired" })] });
    const r = await client(hub.url).requestDecision(ARGS, extra().e);
    expect(textOf(r)).toContain("expired with no answer");
    expect(textOf(r)).toContain('(your recommendation was "Postgres")');
  });

  test("cancelled by the operator", async () => {
    const hub = fakeHub({ waits: [() => Response.json({ status: "cancelled" })] });
    const r = await client(hub.url).requestDecision(
      { ...ARGS, options: ARGS.options.map((o) => ({ label: o.label })) },
      extra().e,
    );
    expect(textOf(r)).toContain("cancelled this decision");
  });

  test("hub down: ask in chat instead", async () => {
    const r = await client("http://127.0.0.1:9").requestDecision(ARGS, extra().e);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(OFFLINE_MSG);
  });

  test("409 ignored session, and other rejections", async () => {
    const ignored = fakeHub({
      create: () => Response.json({ error: "ignored", ignored: true }, { status: 409 }),
    });
    const r = await client(ignored.url).requestDecision(ARGS, extra().e);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(IGNORED_MSG);

    const bad = fakeHub({ create: () => new Response("nope", { status: 400 }) });
    const r2 = await client(bad.url).requestDecision(ARGS, extra().e);
    expect(textOf(r2)).toBe("Mission control rejected the decision (400): nope");
  });

  test("hub restarted with a fresh database (404 on wait)", async () => {
    const hub = fakeHub({ waits: [() => new Response("gone", { status: 404 })] });
    const r = await client(hub.url).requestDecision(ARGS, extra().e);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("forgot this decision");
  });

  test("retries a broken wait, then gives up after repeated failures", async () => {
    const broken = () => new Response("not json");
    const recovers = fakeHub({
      waits: [broken, () => Response.json({ status: "answered", answer: "SQLite" })],
    });
    expect(textOf(await client(recovers.url).requestDecision(ARGS, extra().e))).toBe(
      "DECISION: SQLite",
    );

    const dead = fakeHub({ waits: [broken, broken, broken, broken] });
    const c = client(dead.url);
    const r = await c.requestDecision(ARGS, extra().e);
    expect(textOf(r)).toContain("Lost contact with mission control");
    expect(c.inflight()).toEqual([]);
  });

  test("aborting the call cancels the card on the hub", async () => {
    const hub = fakeHub({});
    const { e, ac } = extra();
    const c = client(hub.url);
    const pending = c.requestDecision(ARGS, e);
    await Bun.sleep(30);
    expect(c.inflight()).toEqual(["d1"]);
    ac.abort();
    const r = await pending;
    expect(textOf(r)).toBe("Decision request was aborted.");
    await Bun.sleep(20);
    expect(hub.seen.some((s) => s.path === "/api/decisions/d1/cancel")).toBe(true);
  });

  test("cancelAll cancels every waiting decision (shutdown)", async () => {
    const hub = fakeHub({});
    const c = client(hub.url);
    const { e, ac } = extra();
    const pending = c.requestDecision(ARGS, e);
    await Bun.sleep(30);
    await c.cancelAll();
    expect(c.inflight()).toEqual([]);
    expect(hub.seen.some((s) => s.path === "/api/decisions/d1/cancel")).toBe(true);
    ac.abort();
    await pending;
  });

  test("needs two options unless free text is allowed", async () => {
    const r = await client("http://127.0.0.1:9").requestDecision(
      { ...ARGS, options: [{ label: "only" }] },
      extra().e,
    );
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("at least 2 options");
  });
});

describe("report_status and the MCP server", () => {
  test("report_status posts the line; offline is an error result", async () => {
    const hub = fakeHub({});
    expect(textOf(await client(hub.url).reportStatus("refactoring"))).toBe("ok");
    expect(hub.seen[0]).toMatchObject({
      path: "/api/status",
      body: { sessionId: "s1", line: "refactoring" },
    });
    const off = await client("http://127.0.0.1:9").reportStatus("x", 500);
    expect(off.isError).toBe(true);
  });

  test("tools are registered and callable over MCP", async () => {
    const hub = fakeHub({
      waits: [() => Response.json({ status: "answered", answer: "SQLite" })],
    });
    const server = createServer(client(hub.url), "9.9.9");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const mcp = new Client({ name: "test", version: "1" });
    await mcp.connect(b);
    expect(mcp.getServerVersion()).toMatchObject({
      name: "agent-mission-control",
      version: "9.9.9",
    });
    const tools = await mcp.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["report_status", "request_decision"]);
    const r = await mcp.callTool({
      name: "request_decision",
      arguments: { question: "Which?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
    });
    expect(r.content).toEqual([{ type: "text", text: "DECISION: SQLite" }]);
    const s = await mcp.callTool({ name: "report_status", arguments: { line: "hi" } });
    expect(s.content).toEqual([{ type: "text", text: "ok" }]);
    await mcp.close();
  });

  test("collectAncestorPids walks up from a pid", () => {
    const pids = collectAncestorPids(process.pid, 3);
    expect(pids[0]).toBe(process.pid);
    expect(pids.length).toBeGreaterThanOrEqual(1);
    expect(collectAncestorPids(1)).toEqual([]);
  });
});
