import { describe, expect, test } from "bun:test";
import type { Decision } from "@amc/shared";
import { cardSentence, pickVoice, spokenName } from "../src/audio/phrases";
import { Announcer, type Clock, type Utterance, VOICE_TIMING } from "../src/audio/voice";

const card = (id: string, extra: Partial<Decision> = {}): Decision => ({
  id,
  sessionId: "s1",
  source: "mcp",
  question: "?",
  options: [],
  urgency: "normal",
  status: "pending",
  createdAt: new Date(0).toISOString(),
  allowFreeText: true,
  ...extra,
});

const q = (question: string) => ({ question, header: "Q", multiSelect: false, options: [] });

/** Fake clock + speaker: lines "finish" only when the test calls finish(). */
function rig() {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const said: string[] = [];
  let pending: (() => void) | null = null;
  const a = new Announcer(
    {
      speak: (u: Utterance, done) => {
        said.push(u.text);
        pending = done;
      },
      cancel: () => {},
    },
    clock,
    () => 0,
  );
  a.configure({
    active: true,
    events: { cards: true, idle: true, red: true, online: true },
    rate: 1,
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  const finish = () => {
    const d = pending;
    pending = null;
    d?.();
  };
  return { a, said, advance, finish };
}

const pepper = { name: "PEPPER", voice: "deadpan" as const, spriteSeed: 1 };
const nova = { name: "NOVA", voice: "deadpan" as const, spriteSeed: 2 };

describe("phrases", () => {
  test("callsigns are spoken title case", () => {
    expect(spokenName("PEPPER")).toBe("Pepper");
    expect(spokenName("NOVA-2")).toBe("Nova 2");
  });

  test("card sentences by source", () => {
    expect(cardSentence("Pepper", [card("a", { source: "ask", questions: [q("x")] })])).toBe(
      "Pepper has a question",
    );
    expect(cardSentence("Pepper", [card("a", { source: "plan" })])).toBe(
      "Pepper wants plan approval",
    );
    expect(cardSentence("Pepper", [card("a", { source: "permission", toolName: "Bash" })])).toBe(
      "Pepper needs permission to run Bash",
    );
    expect(cardSentence("Pepper", [card("a")])).toBe("Pepper needs a decision");
    expect(cardSentence("Pepper", [card("a", { source: "prose" })])).toBe(
      "Pepper is waiting on you",
    );
    expect(cardSentence("Nova", [card("a", { agentId: "x", agentRole: "code-reviewer" })])).toBe(
      "Nova's code reviewer needs you",
    );
  });

  test("voice choice is deterministic and skips novelty voices", () => {
    const v = (name: string, lang = "en-US") => ({
      name,
      lang,
      localService: true,
      voiceURI: name,
    });
    const voices = [v("Zarvox"), v("Samantha"), v("Daniel", "en-GB"), v("Thomas", "fr-FR")];
    expect(pickVoice(voices, 0)?.name).toBe("Daniel");
    expect(pickVoice(voices, 1)?.name).toBe("Samantha");
    expect(pickVoice(voices, 3)?.name).toBe(pickVoice(voices, 3)?.name);
  });
});

describe("announcer queue", () => {
  test("never overlaps: the next line waits for the current one", () => {
    const { a, said, advance, finish } = rig();
    a.announce("online", "s1", pepper);
    a.announce("idle", "s2", nova);
    expect(said).toEqual(["Pepper is on the floor."]);
    advance(500);
    expect(said.length).toBe(1);
    finish();
    expect(said).toEqual(["Pepper is on the floor.", "Nova is standing by."]);
  });

  test("a burst of cards for one station collapses into one line", () => {
    const { a, said, advance } = rig();
    a.announce("cards", "s1", pepper, [card("a", { source: "ask", questions: [q("1"), q("2")] })]);
    advance(800);
    a.announce("cards", "s1", pepper, [card("b", { source: "ask", questions: [q("3")] })]);
    expect(said).toEqual([]);
    advance(VOICE_TIMING.burstMs);
    expect(said).toEqual(["Pepper has three questions."]);
  });

  test("answering a card before it is spoken cancels the line", () => {
    const { a, said, advance } = rig();
    a.announce("cards", "s1", pepper, [card("a")]);
    a.dropCards(["a"]);
    advance(5_000);
    expect(said).toEqual([]);
  });

  test("stale lines are dropped", () => {
    const { a, said, advance, finish } = rig();
    a.announce("online", "s1", pepper);
    a.announce("online", "s2", nova);
    advance(VOICE_TIMING.staleMs + 1);
    finish();
    expect(said).toEqual(["Pepper is on the floor."]);
  });

  test("per-station cooldown on the same kind of line", () => {
    const { a, said, advance, finish } = rig();
    a.announce("idle", "s1", pepper);
    finish();
    advance(10_000);
    a.announce("idle", "s1", pepper);
    expect(said.length).toBe(1);
    advance(VOICE_TIMING.cooldownMs);
    a.announce("idle", "s1", pepper);
    expect(said.length).toBe(2);
  });

  test("say() jumps the queue but never interrupts the line already speaking", () => {
    const { a, said, finish } = rig();
    a.announce("online", "s1", pepper);
    a.announce("idle", "s2", nova);
    a.say("Test one.", 0);
    a.say("Test two.", 0);
    expect(said).toEqual(["Pepper is on the floor."]);
    finish();
    finish();
    finish();
    expect(said).toEqual([
      "Pepper is on the floor.",
      "Test one.",
      "Test two.",
      "Nova is standing by.",
    ]);
  });

  test("say() plays while voice is off, announcements do not", () => {
    const { a, said } = rig();
    a.configure({
      active: false,
      events: { cards: true, idle: true, red: true, online: true },
      rate: 1,
    });
    a.announce("online", "s1", pepper);
    a.say("Voice announcements on.", 0);
    expect(said).toEqual(["Voice announcements on."]);
  });

  test("inactive announcer stays silent", () => {
    const { a, said } = rig();
    a.configure({
      active: false,
      events: { cards: true, idle: true, red: true, online: true },
      rate: 1,
    });
    a.announce("online", "s1", pepper);
    expect(said).toEqual([]);
  });
});
