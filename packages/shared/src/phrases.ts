import type { Decision, Persona, PersonaVoice } from "./index";

/**
 * Spoken announcement lines, shared by the UI (which speaks them) and the hub (which pre-renders
 * the common ones through ElevenLabs). Only these fixed shapes are ever spoken: callsign, counts,
 * tool and role names, never card content.
 */

/** What a spoken line is about. Each has its own switch in the voice settings. */
export type VoiceEvent = "cards" | "idle" | "red" | "online";

/** Callsigns are uppercase on screen; TTS spells out all-caps words, so speak them title case. */
export function spokenName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/(^|[^a-z])([a-z])/g, (_, pre: string, c: string) => pre + c.toUpperCase());
}

const NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const count = (n: number) => NUMBERS[n] ?? String(n);

const ROLE_SPOKEN: Record<string, string> = {
  "general-purpose": "subagent",
  child_session: "nested session",
  claude: "nested session",
  explore: "explorer",
};

export function spokenRole(role: string): string {
  const alias = ROLE_SPOKEN[role.toLowerCase()];
  if (alias) return alias;
  const last = role.split(/[:/]/).pop() || role;
  return last.replace(/[-_]+/g, " ").toLowerCase();
}

/** "mcp__github__create_issue" -> "github create issue", "WebFetch" -> "Web Fetch". */
export function spokenTool(tool: string | undefined): string {
  if (!tool) return "a tool";
  if (tool.startsWith("mcp__")) return tool.split("__").slice(1).join(" ").replace(/_/g, " ");
  return tool.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** Everything in one burst of cards shares this key when it is one kind of ask; drives cooldown. */
export function cardsKind(cards: Decision[]): string {
  if (cards.length > 0 && cards.every((d) => d.agentRole)) {
    const roles = new Set(cards.map((d) => d.agentRole));
    if (roles.size === 1) return `crew:${cards[0]?.agentRole}`;
  }
  if (cards.some((d) => d.agentRole)) return "mixed";
  const sources = new Set(cards.map((d) => d.source));
  return sources.size === 1 ? (cards[0]?.source ?? "mixed") : "mixed";
}

/** The literal event, no flavour: "Pepper has three questions". */
export function cardSentence(name: string, cards: Decision[]): string {
  const n = cards.length;
  const kind = cardsKind(cards);
  if (kind.startsWith("crew:")) return `${name}'s ${spokenRole(kind.slice(5))} needs you`;
  const first = cards[0];
  switch (kind) {
    case "ask": {
      const q = cards.reduce((sum, d) => sum + Math.max(1, d.questions?.length ?? 1), 0);
      return q > 1 ? `${name} has ${count(q)} questions` : `${name} has a question`;
    }
    case "plan":
      return n > 1 ? `${name} has ${count(n)} plans to approve` : `${name} wants plan approval`;
    case "permission": {
      const tools = new Set(cards.map((d) => d.toolName));
      if (n === 1 || tools.size === 1)
        return `${name} needs permission to run ${spokenTool(first?.toolName)}`;
      return `${name} has ${count(n)} permission requests`;
    }
    case "mcp":
      return n > 1 ? `${name} needs ${count(n)} decisions` : `${name} needs a decision`;
    case "mixed":
      return `${name} has ${count(n)} cards waiting`;
    default:
      return `${name} is waiting on you`;
  }
}

export function eventSentence(event: Exclude<VoiceEvent, "cards">, name: string): string {
  switch (event) {
    case "idle":
      return `${name} is standing by`;
    case "red":
      return `${name} has been waiting five minutes`;
    case "online":
      return `${name} is on the floor`;
  }
}

type Tint = (sentence: string, name: string) => string;

/**
 * Persona flavour wraps the literal sentence and never replaces it, so the event stays obvious
 * whatever the voice. Card lines get a few extra variants where the persona has a stock phrase.
 */
const TINTS: Record<PersonaVoice, { any: Tint[]; cards?: Tint[] }> = {
  deadpan: { any: [(s) => `${s}.`, (s) => `${s}. Naturally.`] },
  gungho: { any: [(s) => `${s}!`, (s) => `Heads up! ${s}!`] },
  anxious: { any: [(s) => `Um. ${s}.`, (s) => `${s}. Sorry.`] },
  noir: { any: [(s) => `${s}. It's always something.`, (s) => `Word is, ${s}.`] },
  bureaucrat: { any: [(s) => `For your attention. ${s}.`, (s) => `${s}. Please action.`] },
  pirate: {
    any: [(s) => `Ahoy! ${s}.`, (s) => `${s}, arr.`],
    cards: [(s, n) => `${n} be needin' ye. ${s}.`],
  },
  robot: {
    any: [(s) => `Unit ${s}.`, (s) => `Beep. Unit ${s}.`],
    cards: [(s, n) => `Unit ${n} requires input. ${s}.`],
  },
};

export function tint(
  voice: PersonaVoice,
  event: VoiceEvent,
  sentence: string,
  name: string,
  rng: () => number = Math.random,
): string {
  const t = TINTS[voice] ?? TINTS.deadpan;
  const pool = event === "cards" && t.cards ? [...t.any, ...t.cards] : t.any;
  const pick = pool[Math.floor(rng() * pool.length)] ?? pool[0];
  return pick ? pick(sentence, name) : `${sentence}.`;
}

/**
 * A persona's phrasing is fixed by its seed: pass this as tint's rng and the same persona always
 * says the same event the same way. Keeps a character consistent, and means the lines the hub
 * pre-renders are the lines the UI actually asks for.
 */
export function personaVariant(seed: number): () => number {
  const f = (((seed >>> 0) * 2654435761) >>> 0) / 2 ** 32;
  return () => f;
}

/** The few lines every persona says early and often, in its own phrasing. */
const CORE: { event: VoiceEvent; sentence: (name: string) => string }[] = [
  { event: "online", sentence: (n) => eventSentence("online", n) },
  { event: "idle", sentence: (n) => eventSentence("idle", n) },
  { event: "cards", sentence: (n) => `${n} has a question` },
  { event: "cards", sentence: (n) => `${n} needs permission to run Bash` },
  { event: "cards", sentence: (n) => `${n} wants plan approval` },
  { event: "red", sentence: (n) => eventSentence("red", n) },
];

/**
 * What the hub pre-renders through ElevenLabs for a new session (~250 characters). Everything
 * else (other tools, crew roles, counts) is rendered and cached the first time it is said.
 */
export function coreLines(persona: Pick<Persona, "name" | "voice" | "spriteSeed">): string[] {
  const name = spokenName(persona.name);
  const rng = personaVariant(persona.spriteSeed);
  return CORE.map((c) => tint(persona.voice, c.event, c.sentence(name), name, rng));
}
