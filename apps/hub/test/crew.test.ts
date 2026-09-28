import { afterEach, describe, expect, test } from "bun:test";
import type { DecisionWaitResponse, Session } from "@amc/shared";
import { crewKind, crewRole } from "../src/crew";
import { sleep, startTestHub, type TestHub } from "./helpers";

const PARENT = "22347d64-a9d0-4f9d-96ae-21944bf2b9c9";
const SUB = "a098142c5545132d2";
const MATE = "ainvestigator-7f3a";

// Assigned per test; the pure heuristics test at the top never starts a hub.
let t: TestHub;
afterEach(() => t?.stop());

const session = async (id: string): Promise<Session> => {
  const s = (await t.state()).sessions.find((x) => x.id === id);
  if (!s) throw new Error(`no session ${id}`);
  return s;
};

describe("crew heuristics", () => {
  test("hex agent ids are subagents, named ones are teammates", () => {
    expect(crewKind(SUB)).toBe("subagent");
    expect(crewKind(MATE)).toBe("teammate");
    expect(crewRole(SUB, "Explore")).toBe("Explore");
    expect(crewRole(MATE, undefined)).toBe("investigator");
    expect(crewRole(SUB, undefined)).toBe("subagent");
  });
});

describe("subagent and teammate crew", () => {
  test("agent_id hooks upsert crew without touching the parent's own status", async () => {
    t = startTestHub();
    await t.hook("SessionStart", 63723, { session_id: PARENT, cwd: "/tmp/p" });
    await t.hook("PreToolUse", 63723, { session_id: PARENT, tool_name: "Agent" });
    await t.hook("SubagentStart", 63723, {
      session_id: PARENT,
      agent_id: SUB,
      agent_type: "general-purpose",
    });
    await t.hook("PreToolUse", 63723, {
      session_id: PARENT,
      agent_id: SUB,
      agent_type: "general-purpose",
      tool_name: "Bash",
    });
    await t.hook("PreToolUse", 63723, {
      session_id: PARENT,
      agent_id: MATE,
      agent_type: "investigator",
      tool_name: "Read",
    });

    let s = await session(PARENT);
    expect(s.lastTool).toBe("Agent");
    expect(s.stats.toolCalls).toBe(1);
    expect(s.crew).toHaveLength(2);
    const sub = s.crew.find((m) => m.id === SUB);
    expect(sub).toMatchObject({
      kind: "subagent",
      role: "general-purpose",
      status: "working",
      toolCalls: 1,
      lastTool: "Bash",
    });
    expect(s.crew.find((m) => m.id === MATE)?.kind).toBe("teammate");

    // Main thread ends its turn while crew is still out: parent stays working.
    await t.hook("Stop", 63723, { session_id: PARENT });
    s = await session(PARENT);
    expect(s.status).toBe("working");
    expect(s.blockedSince).toBeUndefined();

    const log = (await t.state()).log.filter((l) => l.agentId === SUB);
    expect(log.length).toBeGreaterThan(0);
    expect(log[0]?.agentRole).toBe("general-purpose");
  });

  test("SubagentStop marks done, sweep drops it after the grace period, parent goes idle", async () => {
    t = startTestHub({}, undefined, { crewGraceMs: 60_000 });
    await t.hook("SessionStart", 63723, { session_id: PARENT });
    await t.hook("SubagentStart", 63723, {
      session_id: PARENT,
      agent_id: SUB,
      agent_type: "Explore",
    });
    await t.hook("Stop", 63723, { session_id: PARENT });
    expect((await session(PARENT)).status).toBe("working");

    await t.hook("SubagentStop", 63723, {
      session_id: PARENT,
      agent_id: SUB,
      agent_type: "Explore",
      agent_transcript_path: "/tmp/x.jsonl",
    });
    let s = await session(PARENT);
    expect(s.crew[0]?.status).toBe("done");
    expect(s.crew[0]?.endedAt).toBeString();
    expect(s.status).toBe("idle");

    t.hub.sessions.sweep(Date.now() + 30_000);
    expect((await session(PARENT)).crew).toHaveLength(1);
    t.hub.sessions.sweep(Date.now() + 61_000);
    s = await session(PARENT);
    expect(s.crew).toHaveLength(0);
  });

  test("a subagent permission prompt blocks the parent until that agent runs again", async () => {
    t = startTestHub();
    await t.hook("SessionStart", 63723, { session_id: PARENT });
    await t.hook("PermissionRequest", 63723, {
      session_id: PARENT,
      agent_id: SUB,
      agent_type: "Explore",
      tool_name: "Bash",
    });
    expect((await session(PARENT)).status).toBe("waiting_permission");
    await t.hook("PreToolUse", 63723, {
      session_id: PARENT,
      agent_id: SUB,
      agent_type: "Explore",
      tool_name: "Bash",
    });
    expect((await session(PARENT)).status).toBe("working");
  });
});

describe("idle while crew is working (#16)", () => {
  const idleLines = async () =>
    (await t.state()).log.filter((l) => l.sessionId === PARENT && l.kind === "idle");

  test("idle_prompt with a busy teammate stays working; idle starts when the crew finishes", async () => {
    t = startTestHub();
    await t.hook("SessionStart", 63723, { session_id: PARENT });
    await t.hook("SubagentStart", 63723, { session_id: PARENT, agent_id: MATE });
    await t.hook("Stop", 63723, { session_id: PARENT });
    await t.hook("Notification", 63723, {
      session_id: PARENT,
      notification_type: "idle_prompt",
      message: "Claude is waiting for your input",
    });

    let s = await session(PARENT);
    expect(s.status).toBe("working");
    expect(s.blockedSince).toBeUndefined();
    expect(await idleLines()).toHaveLength(0);

    await sleep(20);
    const before = Date.now();
    await t.hook("Stop", 63723, { session_id: PARENT, agent_id: MATE });
    s = await session(PARENT);
    expect(s.status).toBe("idle");
    // The idle clock starts when the crew finished, not at the main thread's Stop.
    expect(Date.parse(s.blockedSince ?? "")).toBeGreaterThanOrEqual(before);
    expect(await idleLines()).toHaveLength(1);
  });

  test("main thread back at work before the crew finishes: no idle transition", async () => {
    t = startTestHub();
    await t.hook("SessionStart", 63723, { session_id: PARENT });
    await t.hook("SubagentStart", 63723, { session_id: PARENT, agent_id: SUB });
    await t.hook("Stop", 63723, { session_id: PARENT });
    await t.hook("UserPromptSubmit", 63723, { session_id: PARENT, prompt: "more" });
    await t.hook("SubagentStop", 63723, { session_id: PARENT, agent_id: SUB });
    const s = await session(PARENT);
    expect(s.status).toBe("working");
    expect(await idleLines()).toHaveLength(0);
  });

  test("a crew member silent past the stale timeout stops pinning the session", async () => {
    t = startTestHub();
    await t.hook("SessionStart", 63723, { session_id: PARENT });
    await t.hook("SubagentStart", 63723, { session_id: PARENT, agent_id: SUB });
    await t.hook("Notification", 63723, {
      session_id: PARENT,
      notification_type: "idle_prompt",
    });
    expect((await session(PARENT)).status).toBe("working");

    t.hub.sessions.sweep(Date.now() + t.hub.config.crewStaleMs - 1_000);
    expect((await session(PARENT)).status).toBe("working");

    t.hub.sessions.sweep(Date.now() + t.hub.config.crewStaleMs + 1_000);
    const s = await session(PARENT);
    expect(s.crew[0]?.status).toBe("done");
    expect(s.status).toBe("idle");
    expect(s.blockedSince).toBeString();
    expect(await idleLines()).toHaveLength(1);
  });

  test("a crew member waiting on a decision is never timed out as stale", async () => {
    t = startTestHub();
    await t.hook("SessionStart", 63723, { session_id: PARENT });
    await t.hook("SubagentStart", 63723, { session_id: PARENT, agent_id: SUB });
    await t.hook("Stop", 63723, { session_id: PARENT });
    t.hub.sessions.setCrewWaiting(PARENT, SUB, true);
    t.hub.sessions.sweep(Date.now() + t.hub.config.crewStaleMs + 1_000);
    const s = await session(PARENT);
    expect(s.crew[0]?.status).toBe("waiting_decision");
    expect(s.status).toBe("working");
  });
});

describe("decision attribution", () => {
  test("PreToolUse(request_decision) with agent_id attributes the following POST", async () => {
    t = startTestHub();
    await t.hook("SessionStart", 63723, { session_id: PARENT });
    await t.hook("SubagentStart", 63723, {
      session_id: PARENT,
      agent_id: SUB,
      agent_type: "general-purpose",
    });
    await t.hook("PreToolUse", 63723, {
      session_id: PARENT,
      agent_id: SUB,
      agent_type: "general-purpose",
      tool_name: "mcp__mission-control__request_decision",
      tool_input: { question: "subagent test?", options: [{ label: "yes" }, { label: "no" }] },
    });
    const res = await t.post<{ id: string }>("/api/decisions", {
      sessionId: PARENT,
      source: "mcp",
      question: "subagent test?",
      options: [{ label: "yes" }, { label: "no" }],
      // A caller cannot claim attribution itself.
      agentId: "spoofed",
    });
    expect(res.status).toBe(201);

    let state = await t.state();
    const d = state.decisions.find((x) => x.id === res.body.id);
    expect(d?.agentId).toBe(SUB);
    expect(d?.agentRole).toBe("general-purpose");
    let s = state.sessions.find((x) => x.id === PARENT);
    expect(s?.status).toBe("waiting_decision");
    expect(s?.crew.find((m) => m.id === SUB)?.status).toBe("waiting_decision");
    expect(state.log.find((l) => l.kind === "decision_requested")?.agentId).toBe(SUB);

    // A second, unrelated question from the main thread is not attributed.
    const main = await t.post<{ id: string }>("/api/decisions", {
      sessionId: PARENT,
      source: "mcp",
      question: "main thread?",
      options: [{ label: "ok" }],
    });
    state = await t.state();
    expect(state.decisions.find((x) => x.id === main.body.id)?.agentId).toBeUndefined();

    await t.post(`/api/decisions/${res.body.id}/answer`, { answer: "yes" });
    const w = await t.get<DecisionWaitResponse>(`/api/decisions/${res.body.id}/wait?timeoutMs=0`);
    expect(w.body.status).toBe("answered");
    s = await session(PARENT);
    expect(s.crew.find((m) => m.id === SUB)?.status).toBe("working");
  });
});

describe("child sessions", () => {
  // child claude 75598 -> zsh 75596 -> parent claude 73854 -> zsh 73852 -> ...
  const tree: Record<number, number> = { 75596: 73854, 73854: 73852, 73852: 19611, 19611: 1 };
  const ancestry = (pid: number) => {
    const out: number[] = [];
    for (let p = pid; p > 1 && out.length < 8; p = tree[p] ?? 1) out.push(p);
    return out;
  };
  const CHILD = "115df60c-02bc-41b1-9d5e-d75e5fee6043";
  const PAR = "113c3bd9-6395-4375-87b7-4baf3a75b7c3";

  test("SessionStart with X-Claude-Ppid links a nested claude to its parent and mirrors status", async () => {
    t = startTestHub({}, undefined, { ancestry, crewGraceMs: 60_000 });
    await t.hook("SessionStart", 73854, { session_id: PAR }, { "x-claude-ppid": "73852" });
    await t.hook("SessionStart", 75598, { session_id: CHILD }, { "x-claude-ppid": "75596" });

    let child = await session(CHILD);
    expect(child.parentSessionId).toBe(PAR);
    // Held until the child engages; then every line, session_start included,
    // is filed under the parent's crew.
    await t.hook("UserPromptSubmit", 75598, { session_id: CHILD, prompt: "go" });
    const childLog = (await t.state()).log.filter((l) => l.sessionId === CHILD);
    expect(childLog.length).toBeGreaterThan(0);
    for (const l of childLog) expect(l).toMatchObject({ agentId: CHILD, agentRole: "claude" });
    let parent = await session(PAR);
    expect(parent.parentSessionId).toBeUndefined();
    expect(parent.crew).toHaveLength(1);
    expect(parent.crew[0]).toMatchObject({ id: CHILD, kind: "child_session", role: "claude" });

    // Parent waits on the child (its Bash tool is running `claude -p`), then goes idle.
    await t.hook("Stop", 73854, { session_id: PAR });
    expect((await session(PAR)).status).toBe("working");

    await t.hook("PreToolUse", 75598, { session_id: CHILD, tool_name: "Read" });
    await sleep(300); // tool churn reaches the parent on the 250ms activity edge
    parent = await session(PAR);
    expect(parent.crew[0]?.lastTool).toBe("Read");
    expect(parent.crew[0]?.toolCalls).toBe(1);

    await t.hook("SessionEnd", 75598, { session_id: CHILD, reason: "exit" });
    parent = await session(PAR);
    expect(parent.crew[0]?.status).toBe("done");
    expect(parent.status).toBe("idle");
    t.hub.sessions.sweep(Date.now() + 61_000);
    expect((await session(PAR)).crew).toHaveLength(0);
    child = (await t.state()).sessions.find((x) => x.id === CHILD) as Session;
    expect(child.status).toBe("offline");
  });

  test("MCP-first reports link via ancestorPids, skipping the session's own claude", async () => {
    t = startTestHub({}, undefined, { ancestry });
    await t.hook("SessionStart", 73854, { session_id: PAR });
    await t.post("/api/status", {
      sessionId: CHILD,
      ancestorPids: [75598, 75596, 73854, 73852],
      line: "mcp online",
    });
    expect((await session(CHILD)).parentSessionId).toBe(PAR);

    // Same claude pid under a new session id (/clear) is not a parent.
    const CLEARED = "99999999-0000-0000-0000-000000000001";
    await t.post("/api/status", {
      sessionId: CLEARED,
      ancestorPids: [73854, 73852, 19611],
      line: "mcp online",
    });
    expect((await session(CLEARED)).parentSessionId).toBeUndefined();
  });

  test("unrelated sessions are not linked", async () => {
    t = startTestHub({}, undefined, { ancestry });
    await t.hook("SessionStart", 50000, { session_id: PAR }, { "x-claude-ppid": "49999" });
    await t.hook("SessionStart", 75598, { session_id: CHILD }, { "x-claude-ppid": "75596" });
    expect((await session(CHILD)).parentSessionId).toBeUndefined();
    expect((await session(PAR)).crew).toHaveLength(0);
  });
});

describe("double-wired projects", () => {
  test("identical hook deliveries within 2s are dropped", async () => {
    t = startTestHub();
    const body = { session_id: PARENT, tool_name: "Bash", tool_use_id: "toolu_1" };
    await t.hook("SessionStart", 63723, { session_id: PARENT });
    await Promise.all([t.hook("PreToolUse", 63723, body), t.hook("PreToolUse", 63723, body)]);
    expect((await session(PARENT)).stats.toolCalls).toBe(1);
    await t.hook("SessionStart", 63723, { session_id: PARENT });
    expect((await t.state()).log.filter((l) => l.kind === "session_start")).toHaveLength(1);
    // A different call is not a duplicate.
    await t.hook("PreToolUse", 63723, { ...body, tool_use_id: "toolu_2" });
    expect((await session(PARENT)).stats.toolCalls).toBe(2);
  });

  test("two identical gate hooks share one card and one answer", async () => {
    t = startTestHub();
    const payload = {
      session_id: PARENT,
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    };
    const a = t.post("/api/hooks/gate", payload);
    const b = t.post("/api/hooks/gate", payload);
    await sleep(30);
    const pending = (await t.state()).decisions;
    expect(pending).toHaveLength(1);
    await t.post(`/api/decisions/${pending[0]?.id}/answer`, { answer: "Allow" });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.body).toEqual(rb.body);
    expect((ra.body as { hookSpecificOutput: unknown }).hookSpecificOutput).toBeDefined();
  });
});
