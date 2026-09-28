// The ?mock=1 simulator is how the floor is demoed and developed without a hub, so it has to
// keep speaking the real ServerEvent protocol. Drive it with fake timers and fold its events
// through the real reducer.
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { ServerEvent } from "@amc/shared";
import { MessageError } from "../src/hub/errors";
import { createMockHub, type MockHub } from "../src/hub/mock";
import { type HubState, initialState, reduce } from "../src/hub/state";

let state: HubState;
let events: ServerEvent[];
let hub: MockHub;

const pending = () => Object.values(state.decisions);
const flush = async (ms: number) => {
  jest.advanceTimersByTime(ms);
  // Let promise continuations queued by fired timers run.
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  jest.useFakeTimers();
  state = initialState;
  events = [];
  hub = createMockHub((ev) => {
    events.push(ev);
    state = reduce(state, ev);
  });
});

afterEach(() => {
  hub.stop();
  jest.useRealTimers();
});

describe("mock hub", () => {
  test("starts with a snapshot of a busy floor", () => {
    expect(events[0]?.type).toBe("snapshot");
    expect(state.hydrated).toBe(true);
    const ids = Object.keys(state.sessions);
    expect(ids).toEqual(expect.arrayContaining(["s_nova", "s_rascal", "s_cipher", "s_moth"]));
    // Every card kind the UI renders is seeded, so the demo exercises them all.
    const sources = new Set(pending().map((d) => d.source));
    expect([...sources].sort()).toEqual(["ask", "mcp", "permission", "plan", "prose"]);
    // A nested session points at its parent so the floor folds it into a crew bay.
    expect(state.sessions.s_nova_kid?.parentSessionId).toBe("s_nova");
    expect(state.log.length).toBeGreaterThan(5);
  });

  test("the first ~70s bring a new session and one card of each kind", async () => {
    const before = new Set(pending().map((d) => d.id));
    await flush(70_000);
    expect(state.sessions.s_pepper?.persona.name).toBe("PEPPER");
    const fresh = pending().filter((d) => !before.has(d.id));
    expect(fresh.map((d) => d.source).sort()).toEqual([
      "ask",
      "ask",
      "mcp",
      "mcp",
      "permission",
      "plan",
      "prose",
    ]);
    // Crew decisions carry the asking agent and do not flip the parent to waiting.
    const crewCard = fresh.find((d) => d.agentId === "ag_explore");
    expect(crewCard?.sessionId).toBe("s_nova");
    // Working stations chatter.
    expect(events.some((e) => e.type === "activity")).toBe(true);
  });

  test("answer resolves the card, resumes the session and logs the ack", async () => {
    const d = pending().find((x) => x.source === "mcp");
    if (!d) throw new Error("seeded mcp card");
    const answered = hub.answer(d.id, { answer: "Drizzle", note: "keep it small" });
    await flush(500);
    await answered;
    expect(state.decisions[d.id]).toBeUndefined();
    const s = state.sessions[d.sessionId];
    expect(s?.status).toBe("working");
    expect(s?.stats.decisionsAnswered).toBeGreaterThan(0);
    const logged = state.log.at(-1);
    expect(logged?.kind).toBe("decision_answered");
    expect(logged?.meta?.answer).toBe("Drizzle");
    expect(logged?.meta?.note).toBe("keep it small");
    // An mcp answer queues a follow-up card for NOVA to keep the demo alive.
    await flush(30_000);
    expect(
      pending().some((x) => x.sessionId === "s_nova" && x.question.includes("tax rounding")),
    ).toBe(true);
  });

  test("ask answers keep the per-question answers", async () => {
    const d = pending().find((x) => x.source === "ask");
    if (!d) throw new Error("seeded ask card");
    const answers = { [d.questions?.[0]?.question ?? ""]: "Bar" };
    const p = hub.answer(d.id, { answer: "Bar", answers });
    await flush(500);
    await p;
    const ev = events.find(
      (e) => e.type === "decision" && e.decision.id === d.id && e.decision.status === "answered",
    );
    expect(ev?.type === "decision" && ev.decision.answers).toEqual(answers);
  });

  test("answering an unknown card fails like an expired one", async () => {
    const p = hub.answer("nope", { answer: "x" });
    const caught = p.catch((e: Error) => e.message);
    await flush(500);
    expect(await caught).toContain("not found");
  });

  test("dismiss retires the card and leaves a note", async () => {
    const d = pending()[0];
    if (!d) throw new Error("seeded card");
    const p = hub.dismiss(d.id);
    await flush(200);
    await p;
    expect(state.sessions[d.sessionId]?.status).toBe("idle");
    expect(state.log.at(-1)?.text).toContain("Card dismissed");
    // Dismissing again is a quiet no-op.
    const again = hub.dismiss(d.id);
    await flush(200);
    await again;
  });

  test("sendMessage starts work, and 'offline' or unknown sessions fail with MessageError", async () => {
    const ok = hub.sendMessage("s_lumen", "please add a CSV header");
    await flush(250);
    await ok;
    expect(state.sessions.s_lumen?.status).toBe("working");
    expect(state.sessions.s_lumen?.statusLine).toContain("please add a CSV header");
    expect(state.log.at(-1)?.text).toBe("Operator: please add a CSV header");
    await flush(25_000);
    expect(state.sessions.s_lumen?.status).toBe("idle");

    const offline = hub.sendMessage("s_lumen", "you offline?").catch((e) => e);
    const missing = hub.sendMessage("s_nobody", "hi").catch((e) => e);
    await flush(250);
    const [a, b] = await Promise.all([offline, missing]);
    expect(a).toBeInstanceOf(MessageError);
    expect((a as MessageError).kind).toBe("unreachable");
    expect((b as MessageError).kind).toBe("other");
  });

  test("stop silences the simulator", async () => {
    hub.stop();
    const n = events.length;
    await flush(120_000);
    expect(events.length).toBe(n);
  });
});
