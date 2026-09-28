import { afterEach, describe, expect, test } from "bun:test";
import type { Decision, DecisionWaitResponse } from "@amc/shared";
import { restartTestHub, sleep, startTestHub, type TestHub } from "./helpers";

const SID = "33333333-aaaa-bbbb-cccc-000000000003";

let t: TestHub;
afterEach(() => t?.stop());

type PermOut = {
  hookSpecificOutput?: {
    hookEventName: string;
    decision: {
      behavior: string;
      message?: string;
      updatedInput?: unknown;
      updatedPermissions?: unknown[];
    };
  };
};

const QUESTIONS = [
  {
    question: "Which database should we use?",
    header: "Database",
    options: [
      { label: "Postgres", description: "Relational" },
      { label: "SQLite", description: "Embedded" },
    ],
    multiSelect: false,
  },
  {
    question: "Which checks should run?",
    header: "Checks",
    options: [{ label: "Lint" }, { label: "Types" }, { label: "Tests" }],
    multiSelect: true,
  },
  {
    question: "Anything else?",
    header: "Notes",
    options: [{ label: "No" }, { label: "Yes" }],
    multiSelect: false,
  },
];

/** Fires the gate hook for a tool and returns the pending decision plus the eventual hook reply. */
async function gate(tool: string, toolInput: unknown, extra: Record<string, unknown> = {}) {
  const reply = t.post<PermOut>("/api/hooks/gate", {
    session_id: SID,
    hook_event_name: "PermissionRequest",
    tool_name: tool,
    tool_input: toolInput,
    ...extra,
  });
  await sleep(30);
  const decision = (await t.state()).decisions[0] as Decision;
  return { reply, decision };
}

describe("AskUserQuestion through the gate", () => {
  test("single, multiSelect and free-text answers come back as updatedInput.answers", async () => {
    t = startTestHub();
    const input = { questions: QUESTIONS };
    const { reply, decision } = await gate("AskUserQuestion", input);
    expect(decision.source).toBe("ask");
    expect(decision.questions).toHaveLength(3);
    expect(decision.question).toBe(QUESTIONS[0]?.question as string);
    expect(decision.options.map((o) => o.label)).toEqual(["Postgres", "SQLite"]);
    expect(decision.allowFreeText).toBe(true);
    expect((await t.state()).sessions[0]?.status).toBe("waiting_decision");

    const answers = {
      "Which database should we use?": "SQLite",
      "Which checks should run?": ["Lint", "Tests"],
      "Anything else?": "Ship it after lunch",
      "Not a question": "dropped",
    };
    const res = await t.post<Decision>(`/api/decisions/${decision.id}/answer`, { answers });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe(
      "Database: SQLite; Checks: Lint + Tests; Notes: Ship it after lunch",
    );

    const out = (await reply).body;
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: {
            questions: QUESTIONS,
            answers: {
              "Which database should we use?": "SQLite",
              "Which checks should run?": ["Lint", "Tests"],
              "Anything else?": "Ship it after lunch",
            },
          },
        },
      },
    });

    const log = (await t.state()).log.map((l) => l.text);
    expect(log).toContain("Asked 3 questions.");
    expect(log).toContain(
      "Answered: Database: SQLite; Checks: Lint + Tests; Notes: Ship it after lunch",
    );
    expect((await t.state()).log.some((l) => l.kind === "permission_prompt")).toBe(false);
  });

  test("missing answers are rejected; an old client's `answer` maps onto the first question", async () => {
    t = startTestHub();
    const multi = await gate("AskUserQuestion", { questions: QUESTIONS });
    const partial = await t.post<{ error: string }>(`/api/decisions/${multi.decision.id}/answer`, {
      answers: { "Which database should we use?": "Postgres" },
    });
    expect(partial.status).toBe(400);
    await t.post(`/api/decisions/${multi.decision.id}/cancel`, {});
    expect((await multi.reply).body).toEqual({});

    const single = await gate("AskUserQuestion", { questions: QUESTIONS.slice(0, 1) });
    const res = await t.post<Decision>(`/api/decisions/${single.decision.id}/answer`, {
      answer: "Postgres",
    });
    expect(res.status).toBe(200);
    expect((await single.reply).body.hookSpecificOutput?.decision.updatedInput).toEqual({
      questions: QUESTIONS.slice(0, 1),
      answers: { "Which database should we use?": "Postgres" },
    });
    const w = await t.get<DecisionWaitResponse>(
      `/api/decisions/${single.decision.id}/wait?timeoutMs=0`,
    );
    expect(w.body).toEqual({
      status: "answered",
      answer: "Postgres",
      answers: { "Which database should we use?": "Postgres" },
    });
  });

  test("times out to an empty reply so the terminal prompt appears", async () => {
    t = startTestHub({ AMC_GATE_TIMEOUT_MS: "100" });
    const out = await t.post<PermOut>("/api/hooks/gate", {
      session_id: SID,
      hook_event_name: "PermissionRequest",
      tool_name: "AskUserQuestion",
      tool_input: { questions: QUESTIONS },
    });
    expect(out.body).toEqual({});
    expect(t.hub.decisions.pending()).toHaveLength(0);
  });
});

describe("ExitPlanMode through the gate", () => {
  const input = { plan: "1. Add table\n2. Backfill" };

  test("Approve allows with the original input", async () => {
    t = startTestHub();
    const { reply, decision } = await gate("ExitPlanMode", input);
    expect(decision.source).toBe("plan");
    expect(decision.plan).toBe(input.plan);
    expect(decision.options.map((o) => o.label)).toEqual([
      "Approve",
      "Approve + auto-accept edits",
      "Keep planning",
    ]);
    await t.post(`/api/decisions/${decision.id}/answer`, { answer: "Approve" });
    expect((await reply).body).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedInput: input },
      },
    });
    const log = (await t.state()).log.map((l) => l.text);
    expect(log).toContain("Wants plan approval.");
    expect(log).toContain("Plan approved.");
  });

  test("Keep planning denies with the operator's note, or a default", async () => {
    t = startTestHub();
    const a = await gate("ExitPlanMode", input);
    await t.post(`/api/decisions/${a.decision.id}/answer`, {
      answer: "Keep planning",
      note: "Cover the rollback too",
    });
    expect((await a.reply).body.hookSpecificOutput?.decision).toEqual({
      behavior: "deny",
      message:
        "The user reviewed your plan and wants changes before you start: Cover the rollback too",
    });

    const b = await gate("ExitPlanMode", input, {
      agent_id: "a098142c5545132d2",
      agent_type: "Plan",
    });
    expect(b.decision.agentId).toBe("a098142c5545132d2");
    expect(b.decision.agentRole).toBe("Plan");
    await t.post(`/api/decisions/${b.decision.id}/answer`, { answer: "Keep planning" });
    expect((await b.reply).body.hookSpecificOutput?.decision).toEqual({
      behavior: "deny",
      message: "The user reviewed your plan and wants you to keep planning before making changes.",
    });
  });
});

describe("prompt answered in the terminal first", () => {
  test("PostToolUse for the tool retires the stale ask card; Stop retires a plan card", async () => {
    t = startTestHub();
    const q = await gate("AskUserQuestion", { questions: QUESTIONS.slice(0, 1) });
    await t.hook("PostToolUse", undefined, { session_id: SID, tool_name: "AskUserQuestion" });
    expect((await q.reply).body).toEqual({});
    expect(t.hub.decisions.pending()).toHaveLength(0);
    expect((await t.state()).log.map((l) => l.text)).toContain("Answered in the terminal.");

    const p = await gate("ExitPlanMode", { plan: "x" });
    // A subagent finishing does not touch the main thread's card.
    await t.hook("Stop", undefined, { session_id: SID, agent_id: "a098142c5545132d2" });
    expect(t.hub.decisions.pending()).toHaveLength(1);
    await t.hook("Stop", undefined, { session_id: SID });
    expect((await p.reply).body).toEqual({});
  });

  test("Approve with auto-accept switches the session to acceptEdits", async () => {
    t = startTestHub();
    const input = { plan: "x", planFilePath: "/tmp/plan.md" };
    const { reply, decision } = await gate("ExitPlanMode", input);
    // The older comma label is still accepted and maps to the same outcome.
    await t.post(`/api/decisions/${decision.id}/answer`, { answer: "Approve, auto-accept edits" });
    expect((await reply).body.hookSpecificOutput?.decision).toEqual({
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
  });
});

describe("gated tool permission answered in the terminal", () => {
  test("PostToolUse for the gated tool_use_id retires the card; another call of the same tool does not", async () => {
    t = startTestHub();
    await t.hook("PreToolUse", undefined, {
      session_id: SID,
      tool_name: "Bash",
      tool_use_id: "toolu_gated",
    });
    const g = await gate("Bash", { command: "rm -rf build" });
    expect(g.decision.source).toBe("permission");

    await t.hook("PostToolUse", undefined, {
      session_id: SID,
      tool_name: "Bash",
      tool_use_id: "toolu_other",
    });
    expect(t.hub.decisions.pending()).toHaveLength(1);

    await t.hook("PostToolUseFailure", undefined, {
      session_id: SID,
      tool_name: "Bash",
      tool_use_id: "toolu_gated",
    });
    expect((await g.reply).body).toEqual({});
    expect(t.hub.decisions.pending()).toHaveLength(0);
    expect((await t.state()).log.map((l) => l.text)).toContain("Answered in the terminal.");
  });

  test("a denied permission reads as the user's own feedback", async () => {
    t = startTestHub();
    const g = await gate("Bash", { command: "ls" });
    await t.post(`/api/decisions/${g.decision.id}/answer`, { answer: "Deny" });
    expect((await g.reply).body.hookSpecificOutput?.decision).toEqual({
      behavior: "deny",
      message: "The user declined this Bash call.",
    });
  });
});

describe("request_decision free text", () => {
  test("mcp decisions always accept a typed answer, even with allowFreeText false", async () => {
    t = startTestHub();
    const res = await t.post<{ id: string }>("/api/decisions", {
      sessionId: SID,
      source: "mcp",
      question: "Which database?",
      options: [{ label: "Postgres" }, { label: "SQLite" }],
      allowFreeText: false,
    });
    expect((await t.state()).decisions[0]?.allowFreeText).toBe(true);
    const ans = await t.post<Decision>(`/api/decisions/${res.body.id}/answer`, {
      answer: "Neither, reuse the DuckDB file",
    });
    expect(ans.status).toBe(200);
    const w = await t.get<DecisionWaitResponse>(`/api/decisions/${res.body.id}/wait?timeoutMs=0`);
    expect(w.body).toEqual({ status: "answered", answer: "Neither, reuse the DuckDB file" });
  });

  test("a pending mcp decision stored before the change takes a typed answer after restart", async () => {
    t = startTestHub();
    const res = await t.post<{ id: string }>("/api/decisions", {
      sessionId: SID,
      source: "mcp",
      question: "Which database?",
      options: [{ label: "Postgres" }, { label: "SQLite" }],
    });
    // Simulate a row written by the old hub.
    const row = t.hub.db
      .query<{ json: string }, [string]>("SELECT json FROM decisions WHERE id = ?")
      .get(res.body.id);
    const old = { ...JSON.parse(row?.json ?? "{}"), allowFreeText: false };
    t.hub.db.run("UPDATE decisions SET json = ? WHERE id = ?", [JSON.stringify(old), res.body.id]);
    t = restartTestHub(t);
    expect((await t.state()).decisions[0]?.allowFreeText).toBe(true);
    const ans = await t.post(`/api/decisions/${res.body.id}/answer`, { answer: "DuckDB" });
    expect(ans.status).toBe(200);
  });

  test("gate cards without free text still reject answers off the list", async () => {
    t = startTestHub();
    const { reply, decision } = await gate("ExitPlanMode", { plan: "x" });
    const res = await t.post(`/api/decisions/${decision.id}/answer`, { answer: "Maybe" });
    expect(res.status).toBe(400);
    await t.post(`/api/decisions/${decision.id}/cancel`, {});
    expect((await reply).body).toEqual({});
  });
});
