import { useSyncExternalStore } from "react";

/**
 * Chiptune cues from bare oscillators, no samples. Browsers refuse to start an AudioContext
 * before a user gesture, so nothing plays until `unlock()` has run from a click or key press;
 * the header button is the explicit path and the first interaction anywhere is the implicit one.
 */
export type Cue = "incoming" | "transmitted" | "klaxon" | "tierUp" | "online" | "idle" | "chip";

type Note = [freq: number, ms: number, wave: OscillatorType];
const CUES: Record<Cue, Note[]> = {
  incoming: [
    [523, 90, "square"],
    [784, 170, "square"],
  ],
  transmitted: [
    [523, 70, "triangle"],
    [659, 70, "triangle"],
    [784, 70, "triangle"],
    [1047, 200, "triangle"],
  ],
  klaxon: [
    [440, 190, "square"],
    [311, 190, "square"],
    [440, 190, "square"],
    [311, 190, "square"],
  ],
  tierUp: [
    [880, 60, "square"],
    [1175, 110, "square"],
  ],
  // A station finished its turn: soft and falling, so it never reads as an alert.
  idle: [
    [784, 140, "sine"],
    [587, 260, "sine"],
  ],
  // A free-form message left the building.
  chip: [
    [988, 40, "square"],
    [1319, 70, "square"],
  ],
  online: [
    [660, 60, "triangle"],
    [990, 60, "triangle"],
    [1320, 120, "triangle"],
  ],
};

const STORAGE_KEY = "amc.muted";

interface AudioState {
  muted: boolean;
  unlocked: boolean;
}

let ctx: AudioContext | null = null;
let state: AudioState = { muted: readMuted(), unlocked: false };
const listeners = new Set<() => void>();

function readMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function set(next: Partial<AudioState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function unlock(): void {
  if (!ctx) ctx = new AudioContext();
  ctx.resume().then(() => set({ unlocked: true }));
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, muted ? "1" : "0");
  } catch {
    // Private mode: the setting just does not persist.
  }
  set({ muted });
}

export function play(cue: Cue): void {
  if (state.muted || !ctx || !state.unlocked) return;
  const master = ctx.createGain();
  master.gain.value = 0.07;
  master.connect(ctx.destination);
  let t = ctx.currentTime;
  for (const [freq, ms, wave] of CUES[cue]) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = wave;
    osc.frequency.value = freq;
    const dur = ms / 1000;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.005);
    env.gain.setValueAtTime(1, t + dur - 0.02);
    env.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(env).connect(master);
    osc.start(t);
    osc.stop(t + dur);
    t += dur;
  }
}

export function useAudio(): AudioState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/**
 * First gesture anywhere unlocks audio; the header button is just the visible version of this.
 * Gestures on that button are skipped here, otherwise pointerdown would unlock before the click
 * lands and the click would read as "mute" instead of "enable".
 */
export function installAutoUnlock(): () => void {
  const handler = (e: Event) => {
    if (e.target instanceof Element && e.target.closest("[data-audio-toggle]")) return;
    if (!state.unlocked) unlock();
  };
  window.addEventListener("pointerdown", handler, { passive: true });
  window.addEventListener("keydown", handler);
  return () => {
    window.removeEventListener("pointerdown", handler);
    window.removeEventListener("keydown", handler);
  };
}
