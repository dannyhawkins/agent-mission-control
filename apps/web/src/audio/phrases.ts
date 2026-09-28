export * from "@amc/shared/phrases";

// macOS ships joke voices (Bells, Bubbles, Zarvox...) that are unintelligible for alerts.
const NOVELTY =
  /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Organ|Pipe Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/i;

export interface SystemVoice {
  name: string;
  lang: string;
  localService: boolean;
  voiceURI: string;
}

/**
 * Every usable voice, best first for this seed. Quality tiers lead: macOS lists downloaded
 * neural voices as "Ava (Premium)" / "Evan (Enhanced)" and they sound far better than the
 * compact defaults; then local voices (offline), then remote ones (Chrome's "Google ...").
 * Inside a tier the seed rotates a stable order, so each persona has its own first choice.
 * English only, novelty voices never.
 */
export function rankVoices<V extends SystemVoice>(voices: readonly V[], seed: number): V[] {
  const english = voices.filter((v) => /^en\b|^en[-_]/i.test(v.lang) && !NOVELTY.test(v.name));
  const premium = english.filter((v) => /\(Premium\)/i.test(v.name));
  const enhanced = english.filter((v) => /\(Enhanced\)/i.test(v.name) && !premium.includes(v));
  const rest = english.filter((v) => !premium.includes(v) && !enhanced.includes(v));
  const tiers = [
    premium,
    enhanced,
    rest.filter((v) => v.localService),
    rest.filter((v) => !v.localService),
  ];
  return tiers.flatMap((tier) => {
    const sorted = [...tier].sort((a, b) => a.voiceURI.localeCompare(b.voiceURI));
    const k = sorted.length ? (seed >>> 0) % sorted.length : 0;
    return [...sorted.slice(k), ...sorted.slice(0, k)];
  });
}

/** Deterministic per persona: same seed, same voice, as long as the installed voices do not change. */
export function pickVoice<V extends SystemVoice>(
  voices: readonly V[],
  seed: number,
): V | undefined {
  return rankVoices(voices, seed)[0];
}

/**
 * Gives every live station its own browser voice: each keeps the voice it already has, a new
 * station takes its best-ranked voice nobody else is using, and when there are more stations
 * than voices, the least-used one. Assignments live for the page's lifetime; the voice list is
 * re-read on voiceschanged, and a voice that disappears is simply reassigned.
 */
export class BrowserVoiceAssigner {
  private stations: { id: string; seed: number }[] = [];
  private byStation = new Map<string, string>();

  setStations(stations: { id: string; seed: number }[]): void {
    this.stations = stations;
    const live = new Set(stations.map((s) => s.id));
    for (const id of this.byStation.keys()) if (!live.has(id)) this.byStation.delete(id);
  }

  voiceFor<V extends SystemVoice>(
    stationId: string | undefined,
    seed: number,
    voices: readonly V[],
  ): V | undefined {
    if (!stationId || !this.stations.some((s) => s.id === stationId))
      return pickVoice(voices, seed);
    this.assign(voices);
    const uri = this.byStation.get(stationId);
    return voices.find((v) => v.voiceURI === uri) ?? pickVoice(voices, seed);
  }

  private assign<V extends SystemVoice>(voices: readonly V[]): void {
    const usable = new Set(rankVoices(voices, 0).map((v) => v.voiceURI));
    const uses = new Map<string, number>();
    for (const s of this.stations) {
      const uri = this.byStation.get(s.id);
      if (!uri || !usable.has(uri) || (uses.get(uri) ?? 0) > 0) {
        this.byStation.delete(s.id);
        continue;
      }
      uses.set(uri, 1);
    }
    for (const s of this.stations) {
      if (this.byStation.has(s.id)) continue;
      const ranked = rankVoices(voices, s.seed);
      const pick =
        ranked.find((v) => !uses.get(v.voiceURI)) ??
        ranked.reduce<V | undefined>(
          (best, v) =>
            !best || (uses.get(v.voiceURI) ?? 0) < (uses.get(best.voiceURI) ?? 0) ? v : best,
          undefined,
        );
      if (!pick) continue;
      this.byStation.set(s.id, pick.voiceURI);
      uses.set(pick.voiceURI, (uses.get(pick.voiceURI) ?? 0) + 1);
    }
  }
}

/**
 * Per-persona pitch 0.8..1.25 and rate 0.9..1.1 from the seed, so stations that share a
 * system voice (more stations than voices) still sound apart.
 */
export function voiceShape(seed: number): { pitch: number; rate: number } {
  const s = seed >>> 0;
  return { pitch: 0.8 + ((s >>> 4) % 10) * 0.05, rate: 0.9 + ((s >>> 9) % 5) * 0.05 };
}
