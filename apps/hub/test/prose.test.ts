import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Decision } from "@amc/shared";
import { extractQuestions, lastAssistantText, NUDGE_REASON } from "../src/prose";
import { startTestHub, type TestHub } from "./helpers";

// Invented, but the same shape as a real end-of-turn message: two numbered questions inline,
// one of them carrying inline code with a "?" in it.
const SAMPLE =
  "Two things still need you: 1. Which service should mint invoice numbers once legacy-billing is retired? 2. Can I keep the deliberate `?? 0` in the monthly-revenue chart as an exception?";
const SAMPLE_QS = [
  "Which service should mint invoice numbers once legacy-billing is retired?",
  "Can I keep the deliberate `?? 0` in the monthly-revenue chart as an exception?",
];
const SID = "44444444-aaaa-bbbb-cccc-000000000004";

let t: TestHub;
afterEach(() => t?.stop());

describe("extractQuestions", () => {
  test("the sample yields exactly its two questions, inline or as a list", () => {
    expect(extractQuestions(SAMPLE)).toEqual(SAMPLE_QS);
    expect(
      extractQuestions(
        `Done.\n\nTwo things still need you:\n\n1. ${SAMPLE_QS[0]}\n2. ${SAMPLE_QS[1]}\n`,
      ),
    ).toEqual(SAMPLE_QS);
  });

  test("second sample: inline code and an either/or question", () => {
    const text =
      "Nothing new: these repeat the pagination finding, the #42 approval and the lockfile gate. I've already approved option B' and the rename, and CartImpl picks that up on its next turn.\n\nTwo answers still needed from you:\n1. Keep the monthly-revenue chart's `?? 0` as an exception?\n2. Will you ask Robin about the `legacy_carts` gap, or shall I draft the message?";
    expect(extractQuestions(text)).toEqual([
      "Keep the monthly-revenue chart's `?? 0` as an exception?",
      "Will you ask Robin about the `legacy_carts` gap, or shall I draft the message?",
    ]);
  });

  test("code fences, inline code and quoted text never produce questions", () => {
    const text = [
      "Refactor is in.",
      "```ts",
      "const x = a ?? b; // why?",
      "const ok = isReady() ? 1 : 2;",
      "```",
      'I briefly wondered "is this even needed?" but it is.',
      "The `a?.b ?? c` chain stays. Everything passes.",
    ].join("\n");
    expect(extractQuestions(text)).toEqual([]);
  });

  test("bullets, sentences mid-paragraph, markdown emphasis, dedupe and a cap of 4", () => {
    const text =
      "Shipped. **Should I also bump the version?** Tests pass.\n- Deploy now or wait?\n* Deploy now or wait?\n- A?\n- B one?\n- C one?\n- D one?";
    expect(extractQuestions(text)).toEqual([
      "Should I also bump the version?",
      "Deploy now or wait?",
      "B one?",
      "C one?",
    ]);
  });

  test("transcript fallback reads the last assistant text from the tail", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amc-tr-"));
    const file = path.join(dir, "t.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "old?" }] },
        }),
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: SAMPLE }] },
        }),
        "",
      ].join("\n"),
    );
    expect(lastAssistantText(file)).toBe(SAMPLE);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

type StopOut = { decision?: string; reason?: string };
const stop = (extra: Record<string, unknown>) =>
  t.post<StopOut>("/api/hooks/stop", {
    session_id: SID,
    hook_event_name: "Stop",
    cwd: "/tmp/p",
    ...extra,
  });

describe("Stop nudge and prose card", () => {
  test("nudges once, then posts a read-only card that escalates until the user replies", async () => {
    t = startTestHub();
    await t.hook("SessionStart", 9000, { session_id: SID, cwd: "/tmp/p" });

    const started = Date.now();
    const first = await stop({ stop_hook_active: false, last_assistant_message: SAMPLE });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(first.body).toEqual({ decision: "block", reason: NUDGE_REASON });
    // A nudged stop is not a stop: Claude carries on.
    let state = await t.state();
    expect(state.sessions[0]?.status).toBe("working");
    expect(state.decisions).toHaveLength(0);

    const second = await stop({ stop_hook_active: true, last_assistant_message: SAMPLE });
    expect(second.body).toEqual({});
    state = await t.state();
    const card = state.decisions[0] as Decision;
    expect(card.source).toBe("prose");
    expect(card.answerable).toBe(false);
    expect(card.options).toEqual([]);
    expect(card.prose).toEqual({ questions: SAMPLE_QS, message: SAMPLE });
    expect(state.sessions[0]?.status).toBe("waiting_decision");
    expect(state.sessions[0]?.blockedSince).toBe(card.createdAt);
    expect(state.log.map((l) => l.text)).toContain("Stopped with 2 open question(s) in chat.");

    await t.hook("UserPromptSubmit", 9000, { session_id: SID, prompt: "use the CRM" });
    state = await t.state();
    expect(state.decisions).toHaveLength(0);
    expect(state.log.map((l) => l.text)).toContain("Answered in the terminal.");
  });

  test("tool activity from the main thread clears the card; a subagent's does not", async () => {
    t = startTestHub({ AMC_NUDGE: "off" });
    const out = await stop({ stop_hook_active: false, last_assistant_message: SAMPLE });
    expect(out.body).toEqual({});
    expect((await t.state()).decisions).toHaveLength(1);
    await t.hook("PreToolUse", 9000, {
      session_id: SID,
      tool_name: "Read",
      agent_id: "a098142c5545132d2",
    });
    expect((await t.state()).decisions).toHaveLength(1);
    await t.hook("PreToolUse", 9000, {
      session_id: SID,
      tool_name: "Read",
      tool_use_id: "toolu_x",
    });
    expect((await t.state()).decisions).toHaveLength(0);
  });

  test("Dismiss from the UI is logged as a dismissal", async () => {
    t = startTestHub({ AMC_NUDGE: "off" });
    await stop({ last_assistant_message: SAMPLE });
    const card = (await t.state()).decisions[0] as Decision;
    const res = await t.post<Decision>(`/api/decisions/${card.id}/cancel`, { dismiss: true });
    expect(res.body.status).toBe("cancelled");
    const texts = (await t.state()).log.map((l) => l.text);
    expect(texts).toContain("Dismissed.");
    expect(texts).not.toContain("Answered in the terminal.");
  });

  test("no questions, a subagent, an ignored session or a double-wired hook: no block, no card", async () => {
    t = startTestHub({ AMC_IGNORE_CWD: "/tmp/ign" });
    expect((await stop({ last_assistant_message: "All done. Tests pass." })).body).toEqual({});
    expect((await t.state()).sessions[0]?.status).toBe("idle");
    expect(
      (await stop({ last_assistant_message: SAMPLE, agent_id: "a098142c5545132d2" })).body,
    ).toEqual({});
    expect(
      (await stop({ session_id: "ign-1", cwd: "/tmp/ign/x", last_assistant_message: SAMPLE })).body,
    ).toEqual({});
    expect((await t.state()).decisions).toHaveLength(0);

    // Two identical deliveries (global + project wiring) get the same single answer.
    const body = { stop_hook_active: false, last_assistant_message: `${SAMPLE} ` };
    const [a, b] = await Promise.all([stop(body), stop(body)]);
    expect(a.body).toEqual({ decision: "block", reason: NUDGE_REASON });
    expect(b.body).toEqual(a.body);
  });
});
