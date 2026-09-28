import { afterAll, afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Decision } from "@amc/shared";
import { changePreview, recentContext } from "../src/context";
import { sleep, startTestHub, type TestHub } from "./helpers";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amc-ctx-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (block: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [block] } });

/** Shaped like a 2.1.280 transcript: one record per content block, plus noise. */
function fixture(name = "t.jsonl", padding = 0): string {
  const file = path.join(dir, name);
  const rows = [
    ...Array.from({ length: padding }, (_, i) => user(`old prompt ${i} ${"x".repeat(200)}`)),
    user("Move the clients table to the new schema and keep the old view working."),
    assistant({ type: "thinking", thinking: "hmm" }),
    assistant({ type: "text", text: "Reading the schema first." }),
    assistant({ type: "tool_use", name: "Read", input: {} }),
    user([{ type: "tool_result", content: "..." }]),
    user("Another Claude session sent a message: <teammate-message>hi</teammate-message>"),
    user("peer note", { origin: { kind: "peer" } }),
    user("<local-command-stdout>ok</local-command-stdout>"),
    JSON.stringify({ type: "attachment" }),
    assistant({ type: "text", text: "Found \u001b[31mtwo\u001b[0m callers of the old view." }),
    assistant({ type: "text", text: "Dropping it would break the weekly report." }),
    assistant({ type: "tool_use", name: "Edit", input: {} }),
    "",
  ];
  fs.writeFileSync(file, rows.join("\n"));
  return file;
}

describe("recentContext", () => {
  test("last typed prompt, skipping tool results, peer and wrapped turns; text before the tool call", () => {
    expect(recentContext(fixture(), { toolName: "Edit" })).toEqual({
      lastPrompt: "Move the clients table to the new schema and keep the old view working.",
      assistantText:
        "Found two callers of the old view.\n\nDropping it would break the weekly report.",
    });
  });

  test("tool not in the transcript yet: the text at the end; Stop text used as given", () => {
    expect(recentContext(fixture(), { toolName: "mcp__x__request_decision" })?.assistantText).toBe(
      "Found two callers of the old view.\n\nDropping it would break the weekly report.",
    );
    expect(recentContext(fixture(), { assistantText: "Final reply?" })?.assistantText).toBe(
      "Final reply?",
    );
  });

  test("trims long text and never throws", () => {
    const file = path.join(dir, "long.jsonl");
    fs.writeFileSync(
      file,
      [user("p".repeat(2000)), assistant({ type: "text", text: "a".repeat(5000) })].join("\n"),
    );
    const ctx = recentContext(file);
    expect(ctx?.lastPrompt?.length).toBeLessThanOrEqual(603);
    expect(ctx?.lastPrompt?.endsWith("...")).toBe(true);
    expect(ctx?.assistantText?.length).toBeLessThanOrEqual(1503);
    expect(recentContext(path.join(dir, "missing.jsonl"))).toBeUndefined();
    expect(recentContext(undefined)).toBeUndefined();
  });

  test("reads only the tail: a multi-megabyte transcript costs well under 50ms", () => {
    const file = fixture("big.jsonl", 20_000); // ~5MB
    const started = performance.now();
    const ctx = recentContext(file, { toolName: "Edit" });
    expect(performance.now() - started).toBeLessThan(50);
    expect(ctx?.lastPrompt).toStartWith("Move the clients table");
  });
});

describe("changePreview", () => {
  test("Edit: context, removed and added lines", () => {
    const p = changePreview("Edit", {
      file_path: "/src/a.ts",
      old_string: "one\ntwo\nthree",
      new_string: "one\nTWO\nthree",
    });
    expect(p).toEqual({
      filePath: "/src/a.ts",
      diff: "@@\n one\n-two\n+TWO\n three",
      truncated: false,
    });
  });

  test("MultiEdit hunks, NotebookEdit source, Write new vs overwrite, and the 120-line cap", () => {
    expect(
      changePreview("MultiEdit", {
        file_path: "/a",
        edits: [
          { old_string: "x", new_string: "y" },
          { old_string: "p", new_string: "q" },
        ],
      })?.diff,
    ).toBe("@@\n-x\n+y\n@@\n-p\n+q");
    expect(
      changePreview("NotebookEdit", {
        notebook_path: "/n.ipynb",
        cell_id: "c1",
        new_source: "print(1)",
      })?.diff,
    ).toBe("@@ cell c1 (replace)\n+print(1)");
    const existing = fixture("exists.txt");
    expect(changePreview("Write", { file_path: existing, content: "hi" })?.diff).toBe(
      "overwrite (file exists)\n+hi",
    );
    const big = changePreview("Write", {
      file_path: path.join(dir, "nope.txt"),
      content: Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"),
    });
    expect(big?.diff.split("\n")[0]).toBe("new file");
    expect(big?.diff.split("\n")).toHaveLength(120);
    expect(big?.truncated).toBe(true);
    expect(changePreview("Bash", { command: "ls" })).toBeUndefined();
  });
});

describe("cards carry context", () => {
  let t: TestHub;
  afterEach(() => t?.stop());
  const SID = "77777777-aaaa-bbbb-cccc-000000000007";

  test("gated Edit: recentContext + changePreview; mcp decision uses the stored transcript", async () => {
    t = startTestHub();
    const transcript = fixture("hub.jsonl");
    await t.hook("SessionStart", 1, { session_id: SID, transcript_path: transcript });
    const reply = t.post("/api/hooks/gate", {
      session_id: SID,
      hook_event_name: "PermissionRequest",
      transcript_path: transcript,
      tool_name: "Edit",
      tool_input: { file_path: "/src/a.ts", old_string: "a", new_string: "b" },
    });
    await sleep(30);
    const gate = (await t.state()).decisions[0] as Decision;
    expect(gate.recentContext?.lastPrompt).toStartWith("Move the clients table");
    expect(gate.recentContext?.assistantText).toStartWith("Found two callers");
    expect(gate.changePreview).toEqual({
      filePath: "/src/a.ts",
      diff: "@@\n-a\n+b",
      truncated: false,
    });
    await t.post(`/api/decisions/${gate.id}/answer`, { answer: "Allow" });
    await reply;

    const res = await t.post<{ id: string }>("/api/decisions", {
      sessionId: SID,
      source: "mcp",
      question: "Keep the old view?",
      options: [{ label: "yes" }, { label: "no" }],
    });
    const mcp = (await t.state()).decisions.find((d) => d.id === res.body.id);
    expect(mcp?.recentContext?.lastPrompt).toStartWith("Move the clients table");
  });
});

describe("crew cards read the subagent's own transcript", () => {
  let t: TestHub;
  afterEach(() => t?.stop());
  const SID = "99999999-aaaa-bbbb-cccc-000000000009";
  const AID = "a098142c5545132d2";

  function layout() {
    const root = fs.mkdtempSync(path.join(dir, "proj-"));
    const main = path.join(root, `${SID}.jsonl`);
    fs.writeFileSync(
      main,
      [
        user("Audit the billing tables."),
        assistant({ type: "text", text: "Sending an Explore agent." }),
        assistant({ type: "tool_use", name: "Agent", input: {} }),
        "",
      ].join("\n"),
    );
    const subDir = path.join(root, SID, "subagents");
    fs.mkdirSync(subDir, { recursive: true });
    const side = (row: string) => JSON.stringify({ ...JSON.parse(row), isSidechain: true });
    fs.writeFileSync(
      path.join(subDir, `agent-${AID}.jsonl`),
      [
        side(user("Audit the billing tables (subagent brief).")),
        side(assistant({ type: "text", text: "invoices has two currency columns that disagree." })),
        side(
          assistant({
            type: "tool_use",
            name: "mcp__mission-control__request_decision",
            input: {},
          }),
        ),
        "",
      ].join("\n"),
    );
    return main;
  }

  test("gate and request_decision cards from a subagent: parent prompt, subagent text", async () => {
    t = startTestHub();
    const main = layout();
    await t.hook("SessionStart", 1, { session_id: SID, transcript_path: main });
    await t.hook("SubagentStart", 1, { session_id: SID, agent_id: AID, agent_type: "Explore" });

    await t.hook("PreToolUse", 1, {
      session_id: SID,
      agent_id: AID,
      agent_type: "Explore",
      tool_name: "mcp__mission-control__request_decision",
      tool_input: { question: "Which currency column wins?" },
    });
    const res = await t.post<{ id: string }>("/api/decisions", {
      sessionId: SID,
      source: "mcp",
      question: "Which currency column wins?",
      options: [{ label: "a" }, { label: "b" }],
    });
    const d = (await t.state()).decisions.find((x) => x.id === res.body.id);
    expect(d?.agentId).toBe(AID);
    expect(d?.recentContext).toEqual({
      lastPrompt: "Audit the billing tables.",
      assistantText: "invoices has two currency columns that disagree.",
    });
  });

  test("agent_transcript_path from a hook wins over the derived path", async () => {
    t = startTestHub();
    const main = layout();
    const elsewhere = path.join(dir, "elsewhere.jsonl");
    fs.writeFileSync(
      elsewhere,
      `${JSON.stringify({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "From the reported path." }] } })}\n`,
    );
    await t.hook("SessionStart", 1, { session_id: SID, transcript_path: main });
    await t.hook("SubagentStop", 1, {
      session_id: SID,
      agent_id: AID,
      agent_type: "Explore",
      agent_transcript_path: elsewhere,
    });
    const reply = t.post("/api/hooks/gate", {
      session_id: SID,
      agent_id: AID,
      agent_type: "Explore",
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    await sleep(30);
    const d = (await t.state()).decisions[0];
    expect(d?.recentContext?.assistantText).toBe("From the reported path.");
    await t.post(`/api/decisions/${d?.id}/answer`, { answer: "Allow" });
    await reply;
  });
});
