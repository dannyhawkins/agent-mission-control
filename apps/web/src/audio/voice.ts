import type { Decision, Persona, PersonaVoice, VoiceProvider } from "@amc/shared";
import { useSyncExternalStore } from "react";
import { hubSpeaker, providerSpeaker } from "./eleven";
import {
  BrowserVoiceAssigner,
  cardSentence,
  cardsKind,
  eventSentence,
  personaVariant,
  spokenName,
  tint,
  type VoiceEvent,
  voiceShape,
} from "./phrases";

/**
 * Spoken announcements through the browser's own speech synthesis (system voices, offline), or
 * ElevenLabs audio rendered by the hub when the operator picks it (./eleven, browser fallback).
 * One queue for the whole floor: lines never overlap, go stale after 20s, card bursts for one
 * station collapse into a single line, and a station repeats the same kind of line at most once
 * a minute. Rides on the audio unlock and mute from ./synth: App decides when it is active.
 */

export interface Utterance {
  text: string;
  seed: number;
  pitch: number;
  /** Browser voice rate: the persona's offset times the operator's rate. */
  rate: number;
  /** The operator's rate alone (ElevenLabs playback speed). */
  speed: number;
  voice: PersonaVoice;
  /** Session the line is about, when there is one; the hub looks its persona up. */
  stationId?: string;
}

export interface Speaker {
  /** Must call `done` exactly once when the line has finished or failed. */
  speak(u: Utterance, done: () => void): void;
  cancel(): void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type VoicePersona = Pick<Persona, "name" | "voice" | "spriteSeed">;

interface Item {
  stationId: string;
  /** "say": a literal line from the operator's own click (confirmation, Test voice). */
  event: VoiceEvent | "say";
  text?: string;
  persona: VoicePersona;
  at: number;
  readyAt: number;
  cards: Decision[];
}

export const VOICE_TIMING = {
  /** Anything still queued this long after it happened is old news. */
  staleMs: 20_000,
  /** Cards for one station arriving within this window become one line. */
  burstMs: 3_000,
  /** A card line waits this long for the rest of its burst before it may be spoken. */
  settleMs: 1_200,
  /** Same station, same kind of line: at most once per this window. */
  cooldownMs: 60_000,
};

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class Announcer {
  private queue: Item[] = [];
  private speaking = false;
  private lastSaid = new Map<string, number>();
  private timer: unknown = null;
  private active = false;
  private enabled: Record<VoiceEvent, boolean> = {
    cards: true,
    idle: true,
    red: true,
    online: true,
  };
  private rate = 1;

  constructor(
    private speaker: Speaker,
    private clock: Clock = realClock,
    /** Tests pin the phrasing; by default each persona keeps its own (personaVariant). */
    private rng?: () => number,
  ) {}

  configure(opts: { active: boolean; events: Record<VoiceEvent, boolean>; rate: number }): void {
    this.enabled = { ...opts.events };
    this.rate = opts.rate;
    this.queue = this.queue.filter((i) => i.event === "say" || this.enabled[i.event]);
    if (opts.active === this.active) return;
    this.active = opts.active;
    if (!opts.active) {
      this.queue = [];
      this.clearTimer();
      this.speaker.cancel();
    }
  }

  isActive(): boolean {
    return this.active;
  }

  /** Queue a line. Card lines pass the new pending decisions for that station. */
  announce(
    event: VoiceEvent,
    stationId: string,
    persona: VoicePersona,
    cards: Decision[] = [],
  ): void {
    if (!this.active || !this.enabled[event]) return;
    const now = this.clock.now();
    if (event === "cards") {
      const open = this.queue.find(
        (i) =>
          i.event === "cards" && i.stationId === stationId && now - i.at <= VOICE_TIMING.burstMs,
      );
      if (open) {
        for (const d of cards) if (!open.cards.some((c) => c.id === d.id)) open.cards.push(d);
        open.readyAt = Math.min(now + VOICE_TIMING.settleMs, open.at + VOICE_TIMING.burstMs);
        this.pump();
        return;
      }
      if (cards.length === 0) return;
    }
    if (this.cooling({ stationId, event, cards })) return;
    // One pending line per station per non-card event; a second "standing by" adds nothing.
    if (event !== "cards" && this.queue.some((i) => i.event === event && i.stationId === stationId))
      return;
    this.queue.push({
      stationId,
      event,
      persona,
      at: now,
      readyAt: event === "cards" ? now + VOICE_TIMING.settleMs : now,
      cards: [...cards],
    });
    this.pump();
  }

  /** Cards answered or retired before their line was spoken: take them out of it. */
  dropCards(ids: Iterable<string>): void {
    const gone = new Set(ids);
    if (gone.size === 0) return;
    for (const i of this.queue) i.cards = i.cards.filter((d) => !gone.has(d.id));
    this.queue = this.queue.filter((i) => i.event !== "cards" || i.cards.length > 0);
  }

  /** The condition behind a queued line went away (station busy again, escalation cleared). */
  cancel(stationId: string, event: VoiceEvent): void {
    this.queue = this.queue.filter((i) => !(i.stationId === stationId && i.event === event));
  }

  /**
   * A line the operator asked for (voice-on confirmation, Test voice). Jumps ahead of queued
   * announcements but waits for the one already speaking, skips cooldown and event switches,
   * and plays even while voice is off, since the click itself is the request.
   */
  say(text: string, seed: number, from?: { stationId: string; persona: VoicePersona }): void {
    const now = this.clock.now();
    const item: Item = {
      stationId: from?.stationId ?? "",
      event: "say",
      text,
      persona: from?.persona ?? { name: "", voice: "deadpan", spriteSeed: seed },
      at: now,
      readyAt: now,
      cards: [],
    };
    const firstAnnouncement = this.queue.findIndex((i) => i.event !== "say");
    if (firstAnnouncement < 0) this.queue.push(item);
    else this.queue.splice(firstAnnouncement, 0, item);
    this.pump();
  }

  line(persona: VoicePersona, event: VoiceEvent, cards: Decision[] = []): string {
    const name = spokenName(persona.name);
    const sentence = event === "cards" ? cardSentence(name, cards) : eventSentence(event, name);
    return tint(
      persona.voice,
      event,
      sentence,
      name,
      this.rng ?? personaVariant(persona.spriteSeed),
    );
  }

  private key(i: Pick<Item, "stationId" | "event" | "cards">): string {
    if (i.event === "say") return "say";
    return `${i.stationId}:${i.event === "cards" ? cardsKind(i.cards) : i.event}`;
  }

  private cooling(i: Pick<Item, "stationId" | "event" | "cards">): boolean {
    if (i.event === "say") return false;
    const last = this.lastSaid.get(this.key(i));
    return last !== undefined && this.clock.now() - last < VOICE_TIMING.cooldownMs;
  }

  private utterance(text: string, item: Item): Utterance {
    const seed = item.persona.spriteSeed;
    const shape = voiceShape(seed);
    return {
      text,
      seed,
      pitch: shape.pitch,
      rate: shape.rate * this.rate,
      speed: this.rate,
      voice: item.persona.voice,
      ...(item.stationId ? { stationId: item.stationId } : {}),
    };
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private pump(): void {
    if (this.speaking) return;
    this.clearTimer();
    const now = this.clock.now();
    this.queue = this.queue.filter(
      (i) => now - i.at <= VOICE_TIMING.staleMs && (this.active || i.event === "say"),
    );
    while (this.queue.length) {
      const idx = this.queue.findIndex((i) => i.readyAt <= now);
      if (idx < 0) {
        const next = Math.min(...this.queue.map((i) => i.readyAt));
        this.timer = this.clock.setTimeout(() => {
          this.timer = null;
          this.pump();
        }, next - now);
        return;
      }
      const [item] = this.queue.splice(idx, 1);
      if (!item || this.cooling(item)) continue;
      this.lastSaid.set(this.key(item), now);
      this.speaking = true;
      let finished = false;
      this.speaker.speak(
        this.utterance(
          item.event === "say"
            ? (item.text ?? "")
            : this.line(item.persona, item.event, item.cards),
          item,
        ),
        () => {
          if (finished) return;
          finished = true;
          this.speaking = false;
          this.pump();
        },
      );
      return;
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Browser speaker
// ───────────────────────────────────────────────────────────────────────────

/** App keeps this in step with the floor so each live station gets its own system voice. */
export const browserVoices = new BrowserVoiceAssigner();

function browserSpeaker(): Speaker {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  // Chrome returns [] until voiceschanged fires; asking once starts the load.
  let voices: SpeechSynthesisVoice[] = synth?.getVoices() ?? [];
  synth?.addEventListener("voiceschanged", () => {
    voices = synth.getVoices();
  });
  // Chrome garbage-collects an utterance nobody references and then never fires onend.
  let current: SpeechSynthesisUtterance | null = null;
  return {
    speak(u, done) {
      if (!synth) {
        done();
        return;
      }
      if (!voices.length) voices = synth.getVoices();
      const ut = new SpeechSynthesisUtterance(u.text);
      const v = browserVoices.voiceFor(u.stationId, u.seed, voices);
      if (v) {
        ut.voice = v;
        ut.lang = v.lang;
      }
      ut.pitch = u.pitch;
      ut.rate = u.rate;
      let over = false;
      // onend is not guaranteed (engine hiccups, tab throttling); never let the queue jam.
      const guard = setTimeout(finish, 4_000 + u.text.length * 150);
      function finish() {
        if (over) return;
        over = true;
        clearTimeout(guard);
        if (current === ut) current = null;
        done();
      }
      ut.onend = finish;
      ut.onerror = finish;
      current = ut;
      synth.speak(ut);
    },
    cancel() {
      current = null;
      synth?.cancel();
    },
  };
}

export const voiceSupported = typeof window !== "undefined" && "speechSynthesis" in window;

const silent: Speaker = { speak: (_u, done) => done(), cancel: () => {} };
const browser = voiceSupported ? browserSpeaker() : silent;

export const announcer = new Announcer(
  providerSpeaker(() => settings.provider, {
    browser,
    elevenlabs: hubSpeaker({
      fetch: (input, init) => fetch(input, init),
      makeAudio: (url) => new Audio(url),
      objectUrl: { create: (b) => URL.createObjectURL(b), revoke: (u) => URL.revokeObjectURL(u) },
      fallback: browser,
      onFallback: (reason) => noteFallback(reason),
    }),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// Last fallback (shown in the voice popover)
// ───────────────────────────────────────────────────────────────────────────

export interface VoiceFallback {
  at: number;
  reason: string;
}

let fallback: VoiceFallback | null = null;
const fallbackListeners = new Set<() => void>();

export function noteFallback(reason: string): void {
  fallback = { at: Date.now(), reason };
  for (const l of fallbackListeners) l();
}

export function useVoiceFallback(): VoiceFallback | null {
  return useSyncExternalStore(
    (l) => {
      fallbackListeners.add(l);
      return () => fallbackListeners.delete(l);
    },
    () => fallback,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Settings (per browser)
// ───────────────────────────────────────────────────────────────────────────

export interface VoiceSettings {
  enabled: boolean;
  /** "elevenlabs" asks the hub for audio per line and falls back to "browser" on any failure. */
  provider: VoiceProvider;
  events: Record<VoiceEvent, boolean>;
  rate: number;
}

const STORAGE_KEY = "amc.voice";
const DEFAULTS: VoiceSettings = {
  enabled: false,
  provider: "browser",
  events: { cards: true, idle: true, red: true, online: true },
  rate: 1,
};

let settings: VoiceSettings = readSettings();
const listeners = new Set<() => void>();

function readSettings(): VoiceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const saved = JSON.parse(raw) as Partial<VoiceSettings>;
    return {
      enabled: saved.enabled === true,
      provider: saved.provider === "elevenlabs" ? "elevenlabs" : "browser",
      events: { ...DEFAULTS.events, ...saved.events },
      rate: typeof saved.rate === "number" ? saved.rate : DEFAULTS.rate,
    };
  } catch {
    return DEFAULTS;
  }
}

export function updateVoiceSettings(patch: Partial<VoiceSettings>): void {
  settings = { ...settings, ...patch, events: { ...settings.events, ...patch.events } };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode: the setting just does not persist.
  }
  for (const l of listeners) l();
}

export function useVoiceSettings(): VoiceSettings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => settings,
  );
}
