import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Decision, DecisionWaitResponse, ServerEvent } from "@amc/shared";
import { restartTestHub, sleep, startTestHub, type TestHub } from "./helpers";

let t: TestHub;
beforeEach(() => {
  t = startTestHub();
});
afterEach(() => t.stop());

const SID = "11111111-aaaa-bbbb-cccc-000000000001";
type GateOut = { hookSpecificOutput: Record<string, string> };

describe("status transitions from hooks", () => {
  test("SessionStart -> working, permission -> waiting_permission, tool -> working, Stop -> idle, SessionEnd -> offline", async () => {
    await t.hook("SessionStart", 4242, {
      session_id: SID,
      cwd: "/tmp/proj-a",
      source: "startup",
      model: "claude-fable-5-1",
    });
    let s = (await t.state()).sessions.find((x) => x.id === SID);
    expect(s?.status).toBe("working");
    expect(s?.model).toBe("claude-fable-5-1");
    expect(s?.blockedSince).toBeUndefined();

    // PermissionRequest fires first; the later Notification is confirmation, not a second log line.
    await t.hook("PermissionRequest", 4242, { session_id: SID, tool_name: "Bash" });
    s = (await t.state()).sessions.find((x) => x.id === SID);
    expect(s?.status).toBe("waiting_permission");
    expect(s?.lastTool).toBe("Bash");
    const permSince = s?.blockedSince;
    expect(permSince).toBeString();
    expect(s?.claudePid).toBe(4242);
    expect(s?.project).toBe("proj-a");

    await t.hook("Notification", 4242, {
      session_id: SID,
      notification_type: "permission_prompt",
      message: "Claude needs your permission to use Bash",
    });
    s = (await t.state()).sessions.find((x) => x.id === SID);
    expect(s?.status).toBe("waiting_permission");
    expect(s?.blockedSince).toBe(permSince as string);
    const blockedSince = s?.blockedSince;

    // Repeating the same notification keeps the original blockedSince.
    await t.hook("Notification", 4242, { session_id: SID, notification_type: "permission_prompt" });
    s = (await t.state()).sessions.find((x) => x.id === SID);
    expect(s?.blockedSince).toBe(blockedSince);

    await t.hook("PreToolUse", 4242, {
      session_id: SID,
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    s = (await t.state()).sessions.find((x) => x.id === SID);
    expect(s?.status).toBe("working");
    expect(s?.blockedSince).toBeUndefined();
    expect(s?.lastTool).toBe("Bash");
    expect(s?.stats.toolCalls).toBe(1);

    await t.hook("Notification", 4242, { session_id: SID, notification_type: "idle_prompt" });
    s = (await t.state()).sessions.find((x) => x.id === SID);
    expect(s?.status).toBe("idle");
    expect(s?.blockedSince).toBeString();

    await t.hook("UserPromptSubmit", 4242, { session_id: SID, prompt: "go" });
    s = (await t.state()).sessions.find((x) => x.id === SID);
    expect(s?.status).toBe("working");

    await t.hook("Stop", 4242, { session_id: SID, stop_hook_active: false });
    s = (await t.state()).sessions.find((x) => x.id === SID);
    expect(s?.status).toBe("idle");

    await t.hook("SessionEnd", 4242, { session_id: SID, reason: "exit" });
    s = (await t.state()).sessions.find((x) => x.id === SID);
    expect(s?.status).toBe("offline");

    const kinds = (await t.state()).log.filter((l) => l.sessionId === SID).map((l) => l.kind);
    expect(kinds).toEqual(["session_start", "permission_prompt", "idle", "stop", "session_end"]);
  });

  test("X-Claude-Socket header is captured on the record", async () => {
    await fetch(`${t.base}/api/hooks/SessionStart`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-pid": "77",
        "x-claude-socket": "/tmp/cc-socks/77.sock",
      },
      body: JSON.stringify({ session_id: SID, cwd: "/tmp/s" }),
    });
    const row = t.hub.db
      .query<{ json: string }, [string]>("SELECT json FROM sessions WHERE id = ?")
      .get(SID);
    expect(JSON.parse(row?.json ?? "{}").messagingSocket).toBe("/tmp/cc-socks/77.sock");
  });

  test("hooks with garbage bodies still return 200 {}", async () => {
    const res = await fetch(`${t.base}/api/hooks/PreToolUse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  test("silent sessions go offline on sweep and pending decisions expire", async () => {
    await t.hook("SessionStart", 1, { session_id: SID, cwd: "/tmp/x" });
    const { body } = await t.post<{ id: string }>("/api/decisions", {
      sessionId: SID,
      source: "mcp",
      question: "q?",
      options: [{ label: "a" }, { label: "b" }],
    });
    t.hub.sessions.sweep(Date.now() + t.hub.config.offlineAfterMs + 1);
    const s = (await t.state()).sessions.find((x) => x.id === SID);
    expect(s?.status).toBe("offline");
    expect(t.hub.decisions.get(body.id)?.status).toBe("expired");
  });
});

describe("decisions", () => {
  test("long-poll resolves when answered, session shows waiting_decision meanwhile", async () => {
    await t.hook("SessionStart", 777, { session_id: SID, cwd: "/tmp/proj" });
    const created = await t.post<{ id: string; sessionId: string }>("/api/decisions", {
      ancestorPids: [777, 1],
      cwd: "/tmp/proj",
      source: "mcp",
      question: "Postgres or SQLite?",
      options: [{ label: "Postgres", recommended: true }, { label: "SQLite" }],
      context: "new service",
      urgency: "high",
    });
    expect(created.status).toBe(201);
    expect(created.body.sessionId).toBe(SID);

    let s = (await t.state()).sessions.find((x) => x.id === SID);
    expect(s?.status).toBe("waiting_decision");
    expect((await t.state()).decisions.map((d) => d.id)).toEqual([created.body.id]);

    const waiting = t.get<DecisionWaitResponse>(
      `/api/decisions/${created.body.id}/wait?timeoutMs=5000`,
    );
    await sleep(50);
    // Typed answers are allowed on mcp decisions (see ask.test.ts); a blank one is not.
    const bad = await t.post(`/api/decisions/${created.body.id}/answer`, { answer: "  " });
    expect(bad.status).toBe(400);
    const ok = await t.post<Decision>(`/api/decisions/${created.body.id}/answer`, {
      answer: "Postgres",
      note: "use 16",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("answered");

    const result = await waiting;
    expect(result.body).toEqual({ status: "answered", answer: "Postgres", note: "use 16" });

    s = (await t.state()).sessions.find((x) => x.id === SID);
    expect(s?.status).toBe("working");
    expect(s?.stats.decisionsAnswered).toBe(1);
    expect((await t.state()).decisions).toEqual([]);
    const again = await t.post(`/api/decisions/${created.body.id}/answer`, { answer: "SQLite" });
    expect(again.status).toBe(409);
    const kinds = (await t.state()).log.map((l) => l.kind);
    expect(kinds).toContain("decision_requested");
    const answered = (await t.state()).log.find((l) => l.kind === "decision_answered");
    expect(answered?.meta?.answer).toBe("Postgres");
    expect(answered?.meta?.waitedMs).toBeNumber();
    expect(answered?.decisionId).toBe(created.body.id);
  });

  test("long-poll times out with pending, and cancel resolves waiters", async () => {
    const created = await t.post<{ id: string }>("/api/decisions", {
      ancestorPids: [31337],
      source: "mcp",
      question: "free text?",
      options: [],
      allowFreeText: true,
    });
    const timedOut = await t.get<DecisionWaitResponse>(
      `/api/decisions/${created.body.id}/wait?timeoutMs=100`,
    );
    expect(timedOut.body).toEqual({ status: "pending" });

    const waiting = t.get<DecisionWaitResponse>(
      `/api/decisions/${created.body.id}/wait?timeoutMs=5000`,
    );
    await sleep(20);
    await t.post(`/api/decisions/${created.body.id}/cancel`, {});
    expect((await waiting).body).toEqual({ status: "cancelled" });
    expect((await t.get("/api/decisions/nope/wait")).status).toBe(404);
  });

  test("an answer given just before a hub restart is still served after it", async () => {
    const created = await t.post<{ id: string }>("/api/decisions", {
      sessionId: SID,
      source: "mcp",
      question: "survive?",
      options: [{ label: "yes" }, { label: "no" }],
    });
    await t.post(`/api/decisions/${created.body.id}/answer`, { answer: "yes", note: "kept" });
    const reborn = restartTestHub(t);
    t = reborn;
    const after = await t.get<DecisionWaitResponse>(
      `/api/decisions/${created.body.id}/wait?timeoutMs=100`,
    );
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ status: "answered", answer: "yes", note: "kept" });
    // Pending ones survive too and can still be answered.
    const pending = await t.post<{ id: string }>("/api/decisions", {
      sessionId: SID,
      source: "mcp",
      question: "still pending?",
      options: [{ label: "a" }, { label: "b" }],
    });
    t = restartTestHub(t);
    const wait = t.get<DecisionWaitResponse>(
      `/api/decisions/${pending.body.id}/wait?timeoutMs=3000`,
    );
    await sleep(20);
    await t.post(`/api/decisions/${pending.body.id}/answer`, { answer: "b" });
    expect((await wait).body).toEqual({ status: "answered", answer: "b" });
  });

  test("validation", async () => {
    expect(
      (await t.post("/api/decisions", { source: "mcp", options: [{ label: "a" }] })).status,
    ).toBe(400);
    expect(
      (await t.post("/api/decisions", { source: "mcp", question: "q", options: [] })).status,
    ).toBe(400);
  });

  test("gate returns allow/deny JSON and ask on timeout", async () => {
    const gateHub = startTestHub({ AMC_GATE_TIMEOUT_MS: "150" });
    try {
      const gate = gateHub.post<GateOut>("/api/hooks/gate", {
        session_id: SID,
        hook_event_name: "PreToolUse",
        cwd: "/tmp/g",
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" },
      });
      await sleep(30);
      const pending = (await gateHub.state()).decisions;
      expect(pending).toHaveLength(1);
      expect(pending[0]?.source).toBe("permission");
      expect(pending[0]?.toolName).toBe("Bash");
      expect(pending[0]?.context).toBe("rm -rf build");
      await gateHub.post(`/api/decisions/${pending[0]?.id}/answer`, {
        answer: "Deny",
        note: "not on main",
      });
      const out = await gate;
      expect(out.body.hookSpecificOutput).toEqual({
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "The user declined this Bash call: not on main",
      });

      const timeout = await gateHub.post<GateOut>("/api/hooks/gate", {
        session_id: SID,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/tmp/g/a.ts" },
      });
      expect(timeout.body.hookSpecificOutput.permissionDecision).toBe("ask");
      expect((await gateHub.state()).decisions).toHaveLength(0);
      expect(gateHub.hub.decisions.pending()).toHaveLength(0);

      // PermissionRequest variant: different output shape, empty body on timeout.
      const permReq = gateHub.post<Record<string, unknown>>("/api/hooks/gate", {
        session_id: SID,
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      await sleep(30);
      expect((await gateHub.state()).sessions[0]?.status).toBe("waiting_decision");
      const pr = (await gateHub.state()).decisions[0];
      await gateHub.post(`/api/decisions/${pr?.id}/answer`, { answer: "Allow" });
      expect((await permReq).body).toEqual({
        hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
      });
      const permTimeout = await gateHub.post<Record<string, unknown>>("/api/hooks/gate", {
        session_id: SID,
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      expect(permTimeout.body).toEqual({});
      expect(gateHub.hub.decisions.pending()).toHaveLength(0);
    } finally {
      gateHub.stop();
    }
  });
});

describe("correlation", () => {
  test("matches by ancestor pid, then by unique cwd", async () => {
    await t.hook("SessionStart", 100, { session_id: "s-a", cwd: "/tmp/a" });
    await t.hook("SessionStart", 200, { session_id: "s-b", cwd: "/tmp/b" });
    const byPid = await t.post<{ sessionId: string }>("/api/decisions", {
      ancestorPids: [999, 200],
      cwd: "/tmp/a",
      source: "mcp",
      question: "q",
      options: [{ label: "x" }, { label: "y" }],
    });
    expect(byPid.body.sessionId).toBe("s-b");
    const byCwd = await t.post<{ sessionId: string }>("/api/decisions", {
      ancestorPids: [5, 6],
      cwd: "/tmp/a",
      source: "mcp",
      question: "q",
      options: [{ label: "x" }, { label: "y" }],
    });
    expect(byCwd.body.sessionId).toBe("s-a");
  });

  test("creates a provisional session and merges it when the hook arrives", async () => {
    const events: ServerEvent[] = [];
    t.hub.broadcaster.subscribe((ev) => events.push(ev));

    const status = await t.post<{ sessionId: string }>("/api/status", {
      ancestorPids: [5555, 4444],
      cwd: "/tmp/new-proj",
      line: "mcp online",
    });
    expect(status.body.sessionId).toBe("pid:5555");
    const created = await t.post<{ id: string; sessionId: string }>("/api/decisions", {
      ancestorPids: [5555, 4444],
      cwd: "/tmp/new-proj",
      source: "mcp",
      question: "merge me",
      options: [{ label: "yes" }, { label: "no" }],
    });
    expect(created.body.sessionId).toBe("pid:5555");
    const provisional = (await t.state()).sessions.find((s) => s.id === "pid:5555");
    expect(provisional?.status).toBe("waiting_decision");
    const personaName = provisional?.persona.name;

    // The real session announces itself from the same claude pid.
    await t.hook("SessionStart", 5555, { session_id: "real-sess", cwd: "/tmp/new-proj" });
    const state = await t.state();
    expect(state.sessions.map((s) => s.id)).toEqual(["real-sess"]);
    const real = state.sessions[0];
    expect(real?.persona.name).toBe(personaName as string);
    expect(real?.persona.sessionId).toBe("real-sess");
    expect(real?.claudePid).toBe(5555);
    expect(real?.status).toBe("waiting_decision");
    expect(state.decisions[0]?.sessionId).toBe("real-sess");
    expect(state.log.every((l) => l.sessionId === "real-sess")).toBe(true);
    expect(events.some((e) => e.type === "session_removed" && e.sessionId === "pid:5555")).toBe(
      true,
    );

    // Subsequent MCP calls from the same pids land on the real session.
    const later = await t.post<{ sessionId: string }>("/api/status", {
      ancestorPids: [5555, 4444],
      line: "still here",
    });
    expect(later.body.sessionId).toBe("real-sess");

    // Answer flows back through the same decision id.
    const wait = t.get<DecisionWaitResponse>(
      `/api/decisions/${created.body.id}/wait?timeoutMs=3000`,
    );
    await t.post(`/api/decisions/${created.body.id}/answer`, { answer: "yes" });
    expect((await wait).body).toEqual({ status: "answered", answer: "yes" });
  });
});

describe("otlp ingestion", () => {
  test("logs update model/lastTool and metrics update token stats", async () => {
    await t.hook("SessionStart", 1, { session_id: SID, cwd: "/tmp/o" });
    const attr = (key: string, value: Record<string, unknown>) => ({ key, value });
    await t.post("/v1/logs", {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    attr("event.name", { stringValue: "claude_code.api_request" }),
                    attr("session.id", { stringValue: SID }),
                    attr("model", { stringValue: "claude-fable-5-1" }),
                    attr("input_tokens", { intValue: "10" }),
                    attr("output_tokens", { intValue: "5" }),
                  ],
                },
                {
                  attributes: [
                    attr("event.name", { stringValue: "tool_result" }),
                    attr("session.id", { stringValue: SID }),
                    attr("tool_name", { stringValue: "Grep" }),
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    let s = (await t.state()).sessions.find((x) => x.id === SID);
    expect(s?.model).toBe("claude-fable-5-1");
    expect(s?.lastTool).toBe("Grep");
    expect(s?.stats.inputTokens).toBe(10);

    await t.post("/v1/metrics", {
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
                      {
                        asInt: "300",
                        attributes: [
                          attr("session.id", { stringValue: SID }),
                          attr("type", { stringValue: "input" }),
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    s = (await t.state()).sessions.find((x) => x.id === SID);
    // Metrics take over from api_request counting: 10 (events) + 300 (metrics).
    expect(s?.stats.inputTokens).toBe(310);
    expect((await t.post("/v1/traces", {})).status).toBe(200);
  });
});

describe("websocket", () => {
  test("sends a snapshot on connect and pushes events", async () => {
    const ws = new WebSocket(`${t.base.replace("http", "ws")}/ws`);
    const messages: ServerEvent[] = [];
    ws.onmessage = (m) => messages.push(JSON.parse(String(m.data)) as ServerEvent);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    await sleep(30);
    expect(messages[0]?.type).toBe("snapshot");
    await t.hook("SessionStart", 1, { session_id: SID, cwd: "/tmp/ws" });
    // Log lines are held until the session engages (first prompt).
    await t.hook("UserPromptSubmit", 1, { session_id: SID, prompt: "go" });
    await sleep(30);
    expect(messages.some((m) => m.type === "session")).toBe(true);
    expect(messages.some((m) => m.type === "log")).toBe(true);
    ws.close();
  });

  test("CORS headers for the Vite origin", async () => {
    const res = await fetch(`${t.base}/api/state`, {
      headers: { origin: "http://localhost:5173" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const other = await fetch(`${t.base}/api/state`, {
      headers: { origin: "http://evil.example" },
    });
    expect(other.status).toBe(403);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});
