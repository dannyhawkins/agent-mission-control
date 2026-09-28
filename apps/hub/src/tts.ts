import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Persona, PersonaVoice, SpeakFailure, VoiceStatus } from "@amc/shared";
import { coreLines } from "@amc/shared/phrases";
import type { TtsConfig } from "./config";
import type { HubLogger } from "./hublog";

/**
 * Optional ElevenLabs voice for the UI's announcements. The browser voice stays the default; this
 * only runs when the UI picks it and ELEVENLABS_API_KEY is set for the hub.
 *
 * - The key never leaves this module except as the upstream `xi-api-key` header: status reports
 *   `configured`, errors carry HTTP statuses, never the key or upstream bodies.
 * - Audio is cached on disk by sha256(provider, model, voice, settings, text), so each line of
 *   each persona is paid for once. Oldest-used files go first past the size cap.
 * - A daily character cap counts cache misses only, persisted per local day in SQLite.
 * - Nothing here throws out to a route: every failure is a SpeakFailure the UI turns into a
 *   browser-voice fallback for that line.
 */

export interface VoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  speed: number;
  use_speaker_boost: boolean;
}

/** Persona voice -> delivery. ElevenLabs speed range is 0.7..1.2. */
const SETTINGS: Record<
  PersonaVoice,
  Omit<VoiceSettings, "similarity_boost" | "use_speaker_boost">
> = {
  deadpan: { stability: 0.75, style: 0, speed: 1 },
  bureaucrat: { stability: 0.85, style: 0, speed: 0.97 },
  noir: { stability: 0.6, style: 0.25, speed: 0.95 },
  anxious: { stability: 0.35, style: 0.35, speed: 1.08 },
  gungho: { stability: 0.35, style: 0.6, speed: 1.08 },
  pirate: { stability: 0.3, style: 0.7, speed: 1 },
  robot: { stability: 0.9, style: 0, speed: 1.1 },
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
/** -1..1 from a slice of the seed's bits, rounded so cache keys stay short and stable. */
const offset = (seed: number, shift: number) => (((seed >>> shift) & 0xff) / 255) * 2 - 1;
const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Persona voice sets the base delivery; the seed nudges it (speed +/-0.08, stability and style
 * +/-0.1) so two pirates on neighbouring voices still sound like different people. Part of the
 * cache key, so a persona's lines stay consistent.
 */
export function voiceSettings(voice: PersonaVoice, seed = 0): VoiceSettings {
  const base = SETTINGS[voice] ?? SETTINGS.deadpan;
  return {
    stability: round2(clamp(base.stability + offset(seed, 0) * 0.1, 0, 1)),
    similarity_boost: 0.75,
    style: round2(clamp(base.style + offset(seed, 8) * 0.1, 0, 1)),
    speed: round2(clamp(base.speed + offset(seed, 16) * 0.08, 0.7, 1.2)),
    use_speaker_boost: true,
  };
}

export interface ElevenVoice {
  id: string;
  name: string;
  /** Lower-cased name + description + labels (accent, age, use case...) for matching. */
  traits: string;
}

/**
 * Words in a voice's name or labels that suit each persona. ElevenLabs premade voices carry
 * their character in the name ("Callum - Husky Trickster", "Laura - Enthusiast, Quirky
 * Attitude") and in labels, so a pirate gets the husky trickster instead of a coin flip.
 */
const TRAITS: Record<PersonaVoice, string[]> = {
  pirate: ["trickster", "husky", "gravelly", "rough"],
  gungho: ["energetic", "enthusiast", "excited", "upbeat"],
  deadpan: ["laid-back", "casual", "calm", "dry"],
  noir: ["deep", "resonant", "raspy", "storyteller"],
  bureaucrat: ["mature", "formal", "professional", "reassuring"],
  anxious: ["quirky", "young", "nervous"],
  robot: ["neutral", "clear", "crisp"],
};

export function traitScore(voice: PersonaVoice, traits: string): number {
  return (TRAITS[voice] ?? []).reduce((n, w) => n + (traits.includes(w) ? 1 : 0), 0);
}

/**
 * Every voice, best first for this persona. Voices whose traits match the persona voice come
 * first (higher score first; spriteSeed rotates the order inside the matches so personas of the
 * same voice spread out), then the rest in a seed-rotated stable order. Deterministic.
 */
export function rankElevenVoices(
  voices: readonly ElevenVoice[],
  persona: Pick<Persona, "voice" | "spriteSeed">,
): ElevenVoice[] {
  const byId = (a: ElevenVoice, b: ElevenVoice) => a.id.localeCompare(b.id);
  const rotate = <T>(xs: T[]) => {
    const k = xs.length ? (persona.spriteSeed >>> 0) % xs.length : 0;
    return [...xs.slice(k), ...xs.slice(0, k)];
  };
  const scored = voices
    .map((v) => ({ v, score: traitScore(persona.voice, v.traits) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || byId(a.v, b.v));
  // Rotate within the matches but keep a clearly better match ahead of weaker ones.
  const top = scored.length ? (scored[0]?.score ?? 0) : 0;
  const best = scored.filter((x) => x.score === top).map((x) => x.v);
  const weaker = scored.filter((x) => x.score !== top).map((x) => x.v);
  const matched = new Set(scored.map((x) => x.v));
  const rest = [...voices].filter((v) => !matched.has(v)).sort(byId);
  return [...rotate(best), ...rotate(weaker), ...rotate(rest)];
}

/** The persona's first choice (used for lines with no live session, like a test line). */
export function pickElevenVoice(
  voices: readonly ElevenVoice[],
  persona: Pick<Persona, "voice" | "spriteSeed">,
): ElevenVoice | undefined {
  return rankElevenVoices(voices, persona)[0];
}

/**
 * Unique voices across live sessions: keep `current` when it still exists and no other live
 * session holds it; otherwise the best-ranked voice nobody live is using, else the least-used.
 * With `next`, skip past `current` in rank order (re-roll), still preferring unused voices.
 */
export function chooseVoice(
  ranked: readonly ElevenVoice[],
  taken: ReadonlyMap<string, number>,
  current?: string,
  next = false,
): ElevenVoice | undefined {
  if (!next && current && ranked.some((v) => v.id === current) && !taken.get(current)) {
    return ranked.find((v) => v.id === current);
  }
  let order = [...ranked];
  if (next && current) {
    const i = order.findIndex((v) => v.id === current);
    if (i >= 0) order = [...order.slice(i + 1), ...order.slice(0, i)];
  }
  if (!order.length) return ranked[0];
  const free = order.find((v) => !taken.get(v.id));
  if (free) return free;
  return order.reduce((a, v) => ((taken.get(v.id) ?? 0) < (taken.get(a.id) ?? 0) ? v : a));
}

/** GET /v1/voices body -> voices. Stock voices only when there are any (see loadVoices). */
export function parseVoices(body: unknown): ElevenVoice[] {
  const raw = (body as { voices?: unknown } | null)?.voices;
  const all = (Array.isArray(raw) ? raw : []).filter(
    (v): v is Record<string, unknown> =>
      !!v && typeof v.voice_id === "string" && typeof v.name === "string",
  );
  // The account's own clones are personal and should not be dealt out to random stations;
  // they are used only when there is nothing else.
  const premade = all.filter((v) => v.category === "premade");
  return (premade.length ? premade : all).map((v) => {
    const labels =
      v.labels && typeof v.labels === "object"
        ? Object.values(v.labels).filter((x): x is string => typeof x === "string")
        : [];
    const description = typeof v.description === "string" ? v.description : "";
    return {
      id: v.voice_id as string,
      name: v.name as string,
      traits: [v.name, description, ...labels].join(" ").toLowerCase().replace(/_/g, " "),
    };
  });
}

export type SpeakPersona = Pick<Persona, "voice" | "spriteSeed"> & { name?: string };

export type SpeakResult =
  | { ok: true; audio: Uint8Array<ArrayBuffer>; cached: boolean; voiceId: string }
  | ({ ok: false; status: number } & SpeakFailure);

const VOICES_TTL_MS = 60 * 60_000;
/** A failed voice list is retried after this, not on every line. */
const VOICES_RETRY_MS = 60_000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class Tts {
  private voices: { at: number; list: ElevenVoice[] } | undefined;
  private voicesError: { at: number; message: string } | undefined;
  private voicesInflight: Promise<ElevenVoice[] | undefined> | undefined;
  private inflight = new Map<string, Promise<SpeakResult>>();
  private warmed = new Set<string>();
  private warmQueue: { persona: Persona; sessionId: string }[] = [];
  /**
   * Live (engaged, not offline, own station) sessions, oldest first. Set by the hub; voices are
   * unique across these, and the popover lists them.
   */
  liveSessions: () => { sessionId: string; persona: Persona }[] = () => [];
  private warming = false;
  private stopped = false;
  private readonly cacheDir: string;
  private readonly secretsFile: string;
  /** Last seen secrets.env stat ("mtime|mode|size"), so re-reads are only a stat. */
  private secretsStamp = "";
  private fileKey: string | undefined;

  constructor(
    private db: Database,
    private cfg: TtsConfig,
    dataDir: string,
    private logger: HubLogger,
    private fetchImpl: Fetch = (input, init) => fetch(input, init),
    private today: () => string = localDay,
  ) {
    this.cacheDir = path.join(dataDir, "voice-cache");
    this.secretsFile = path.join(dataDir, "secrets.env");
    db.exec("CREATE TABLE IF NOT EXISTS tts_usage (day TEXT PRIMARY KEY, chars INTEGER NOT NULL)");
    // One ElevenLabs voice per session, kept across resume and hub restarts until re-rolled.
    db.exec(
      "CREATE TABLE IF NOT EXISTS voice_assign (session_id TEXT PRIMARY KEY, voice_id TEXT NOT NULL, voice_name TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    this.reloadSecrets();
  }

  /** The env var wins; otherwise <dataDir>/secrets.env, re-read when it changes. */
  private get key(): string | undefined {
    return this.cfg.apiKey ?? this.fileKey;
  }

  get configured(): boolean {
    return !!this.key;
  }

  /**
   * Picks up a new or rotated key in <dataDir>/secrets.env without a restart. Called at start
   * and on every status request (the UI asks when the voice popover opens); a stat when unchanged.
   * The file is refused while group or world can read it, like ssh does with private keys.
   */
  reloadSecrets(): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.secretsFile);
    } catch {
      if (this.secretsStamp) this.logger.info("voice", "secrets.env removed");
      this.secretsStamp = "";
      this.fileKey = undefined;
      return;
    }
    const stamp = `${st.mtimeMs}|${st.mode}|${st.size}`;
    if (stamp === this.secretsStamp) return;
    this.secretsStamp = stamp;
    if (st.mode & 0o077) {
      this.fileKey = undefined;
      this.logger.info(
        "voice",
        `ignoring ${this.secretsFile}: readable by others (mode ${(st.mode & 0o777).toString(8)}), chmod 600 it`,
      );
      return;
    }
    try {
      this.fileKey = parseSecrets(fs.readFileSync(this.secretsFile, "utf8")).ELEVENLABS_API_KEY;
      if (this.fileKey && this.cfg.apiKey) {
        this.logger.info("voice", "ELEVENLABS_API_KEY from the environment wins over secrets.env");
      } else if (this.fileKey) {
        this.logger.info("voice", "ElevenLabs key loaded from secrets.env");
      }
      // A rotated key deserves a fresh voice list (the old one may belong to another account).
      this.voices = undefined;
      this.voicesError = undefined;
    } catch {
      this.fileKey = undefined;
      this.logger.info("voice", `could not read ${this.secretsFile}`);
    }
  }

  stop(): void {
    this.stopped = true;
    this.warmQueue = [];
  }

  usedToday(): number {
    const row = this.db
      .query<{ chars: number }, [string]>("SELECT chars FROM tts_usage WHERE day = ?")
      .get(this.today());
    return row?.chars ?? 0;
  }

  private addUsage(chars: number): void {
    this.db
      .query(
        "INSERT INTO tts_usage (day, chars) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET chars = chars + excluded.chars",
      )
      .run(this.today(), chars);
  }

  async status(): Promise<VoiceStatus> {
    this.reloadSecrets();
    const eleven: VoiceStatus["providers"]["elevenlabs"] = {
      configured: this.configured,
      keySource: this.cfg.apiKey ? "env" : this.fileKey ? "secrets.env" : null,
    };
    let assignments: VoiceStatus["assignments"];
    if (this.configured) {
      const list = await this.voiceList();
      if (list) {
        eleven.voices = list.map(({ id, name }) => ({ id, name }));
        // Oldest first, so a newcomer never takes a voice from a session already talking.
        assignments = [];
        for (const s of this.liveSessions()) {
          const v = this.voiceForSession(s.sessionId, s.persona, list);
          if (v) assignments.push({ sessionId: s.sessionId, voiceName: v.name });
        }
      } else if (this.voicesError) eleven.error = this.voicesError.message;
    }
    return {
      providers: { browser: true, elevenlabs: eleven },
      dailyCharsUsed: this.usedToday(),
      dailyCharsCap: this.cfg.dailyChars,
      ...(assignments ? { assignments } : {}),
    };
  }

  /** Re-roll (next) or look up a session's voice; persisted. Never throws. */
  async assign(
    sessionId: string,
    persona: Persona,
    next: boolean,
  ): Promise<{ ok: true; voiceName: string } | ({ ok: false; status: number } & SpeakFailure)> {
    try {
      if (!this.key) return failAssign(409, "not_configured", "ElevenLabs is not configured");
      const voices = await this.voiceList();
      if (!voices) return failAssign(503, "upstream", this.voicesError?.message ?? "no voices");
      const v = this.voiceForSession(sessionId, persona, voices, next);
      if (!v) return failAssign(503, "no_voice", "the ElevenLabs account has no voices");
      if (next) {
        this.logger.info("voice", "reroll", persona.name, v.name);
        this.schedulePrewarm(sessionId, persona, v.id);
      }
      return { ok: true, voiceName: v.name };
    } catch (err) {
      this.logger.info("voice", "assign error", String(err).slice(0, 120));
      return failAssign(503, "upstream", "voice provider error");
    }
  }

  private voiceForSession(
    sessionId: string,
    persona: Pick<Persona, "voice" | "spriteSeed">,
    voices: readonly ElevenVoice[],
    next = false,
  ): ElevenVoice | undefined {
    const current = this.db
      .query<{ voice_id: string }, [string]>(
        "SELECT voice_id FROM voice_assign WHERE session_id = ?",
      )
      .get(sessionId)?.voice_id;
    const taken = new Map<string, number>();
    const others = this.liveSessions()
      .map((s) => s.sessionId)
      .filter((id) => id !== sessionId);
    if (others.length) {
      const rows = this.db
        .query<{ voice_id: string }, string[]>(
          `SELECT voice_id FROM voice_assign WHERE session_id IN (${others.map(() => "?").join(",")})`,
        )
        .all(...others);
      for (const r of rows) taken.set(r.voice_id, (taken.get(r.voice_id) ?? 0) + 1);
    }
    const v = chooseVoice(rankElevenVoices(voices, persona), taken, current, next);
    if (v && v.id !== current) {
      this.db
        .query(
          "INSERT INTO voice_assign (session_id, voice_id, voice_name, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET voice_id = excluded.voice_id, voice_name = excluded.voice_name, updated_at = excluded.updated_at",
        )
        .run(sessionId, v.id, v.name, new Date().toISOString());
    }
    return v;
  }

  /**
   * Audio for one announcement line, from cache or ElevenLabs. With a session, the line uses
   * that session's own voice and its first success warms the persona's core lines. Never throws.
   */
  async speak(text: string, persona: SpeakPersona, sessionId?: string): Promise<SpeakResult> {
    try {
      const result = await this.render(text, persona, sessionId);
      if (result.ok && sessionId && "name" in persona && persona.name) {
        this.schedulePrewarm(sessionId, persona as Persona, result.voiceId);
      }
      return result;
    } catch (err) {
      this.logger.info("voice", "error", String(err).slice(0, 120));
      return fail(503, "upstream", "voice provider error");
    }
  }

  private async render(
    text: string,
    persona: SpeakPersona,
    sessionId?: string,
  ): Promise<SpeakResult> {
    if (!this.key) return fail(409, "not_configured", "ELEVENLABS_API_KEY is not set for the hub");
    const voices = await this.voiceList();
    if (!voices) {
      const timedOut = this.voicesError?.message.includes("timed out");
      return fail(
        503,
        timedOut ? "timeout" : "upstream",
        this.voicesError?.message ?? "no voice list",
      );
    }
    const voice = sessionId
      ? this.voiceForSession(sessionId, persona, voices)
      : pickElevenVoice(voices, persona);
    if (!voice) return fail(503, "no_voice", "the ElevenLabs account has no voices");
    const settings = voiceSettings(persona.voice, persona.spriteSeed);
    const hash = createHash("sha256")
      .update(JSON.stringify(["elevenlabs", this.cfg.model, voice.id, settings, text]))
      .digest("hex");
    const file = path.join(this.cacheDir, `${hash}.mp3`);

    const hit = readCached(file);
    if (hit) return { ok: true, audio: hit, cached: true, voiceId: voice.id };

    // Prewarm and a live line can ask for the same audio at once; pay for it once.
    const running = this.inflight.get(hash);
    if (running) return running;
    const job = this.fetchAudio(text, voice, settings, file, persona.name).finally(() =>
      this.inflight.delete(hash),
    );
    this.inflight.set(hash, job);
    return job;
  }

  private async fetchAudio(
    text: string,
    voice: ElevenVoice,
    settings: VoiceSettings,
    file: string,
    who: string | undefined,
  ): Promise<SpeakResult> {
    const used = this.usedToday();
    if (used + text.length > this.cfg.dailyChars) {
      return fail(
        409,
        "cap_reached",
        `daily ElevenLabs cap reached (${used}/${this.cfg.dailyChars} characters)`,
      );
    }
    const url = `${this.cfg.baseUrl}/v1/text-to-speech/${encodeURIComponent(voice.id)}?output_format=mp3_44100_128`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "xi-api-key": this.key ?? "",
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({ text, model_id: this.cfg.model, voice_settings: settings }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      const timeout = isTimeout(err);
      this.logger.info("voice", "elevenlabs", timeout ? "timed out" : "unreachable");
      return timeout
        ? fail(503, "timeout", "ElevenLabs timed out")
        : fail(503, "upstream", "ElevenLabs is unreachable");
    }
    if (!res.ok) {
      // Upstream bodies are not logged or relayed: status is enough and bodies are not ours.
      await res.body?.cancel().catch(() => {});
      this.logger.info("voice", "elevenlabs", `HTTP ${res.status}`);
      return fail(503, "upstream", `ElevenLabs answered HTTP ${res.status}`);
    }
    let audio: Uint8Array<ArrayBuffer>;
    try {
      audio = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      return isTimeout(err)
        ? fail(503, "timeout", "ElevenLabs timed out")
        : fail(503, "upstream", "ElevenLabs audio was cut off");
    }
    if (audio.byteLength === 0) return fail(503, "upstream", "ElevenLabs sent no audio");
    this.addUsage(text.length);
    this.logger.info(
      "voice",
      "elevenlabs",
      who ?? "-",
      `${text.length} chars`,
      `(${this.usedToday()}/${this.cfg.dailyChars} today)`,
    );
    this.store(file, audio);
    return { ok: true, audio, cached: false, voiceId: voice.id };
  }

  private store(file: string, audio: Uint8Array): void {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, audio);
      fs.renameSync(tmp, file);
      this.prune();
    } catch (err) {
      // A full or read-only disk costs a re-render next time, nothing more.
      this.logger.info("voice", "cache write failed", String(err).slice(0, 120));
    }
  }

  /** Oldest-used first until under the cap. Hits touch mtime, so mtime is last use. */
  private prune(): void {
    const files = fs
      .readdirSync(this.cacheDir)
      .filter((f) => f.endsWith(".mp3"))
      .map((f) => {
        const p = path.join(this.cacheDir, f);
        const st = fs.statSync(p);
        return { p, size: st.size, used: st.mtimeMs };
      })
      .sort((a, b) => a.used - b.used);
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files) {
      if (total <= this.cfg.cacheMaxBytes) break;
      fs.rmSync(f.p, { force: true });
      total -= f.size;
    }
  }

  private async voiceList(): Promise<ElevenVoice[] | undefined> {
    const now = Date.now();
    if (this.voices && now - this.voices.at < VOICES_TTL_MS) return this.voices.list;
    if (this.voicesError && now - this.voicesError.at < VOICES_RETRY_MS) return this.voices?.list;
    if (!this.voicesInflight) {
      this.voicesInflight = this.loadVoices().finally(() => {
        this.voicesInflight = undefined;
      });
    }
    return this.voicesInflight;
  }

  private async loadVoices(): Promise<ElevenVoice[] | undefined> {
    const failWith = (message: string) => {
      this.voicesError = { at: Date.now(), message };
      this.logger.info("voice", "voice list", message);
      // A stale list still works; a bad key or outage should not silence known voices.
      return this.voices?.list;
    };
    try {
      const res = await this.fetchImpl(`${this.cfg.baseUrl}/v1/voices`, {
        headers: { "xi-api-key": this.key ?? "", accept: "application/json" },
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return failWith(
          res.status === 401 || res.status === 403
            ? `ElevenLabs rejected the API key (HTTP ${res.status})`
            : `ElevenLabs voice list failed (HTTP ${res.status})`,
        );
      }
      const list = parseVoices(await res.json());
      this.voices = { at: Date.now(), list };
      this.voicesError = undefined;
      return list;
    } catch (err) {
      return failWith(isTimeout(err) ? "ElevenLabs timed out" : "ElevenLabs is unreachable");
    }
  }

  /**
   * After a session's first line (or a re-roll), render its persona's core lines in the
   * background, one at a time, so the common announcements are cache hits. Once per session and
   * voice. Stops at the first failure or the cap.
   */
  private schedulePrewarm(sessionId: string, persona: Persona, voiceId: string): void {
    if (!this.cfg.prewarm || this.stopped) return;
    const id = `${sessionId}|${voiceId}`;
    if (this.warmed.has(id)) return;
    this.warmed.add(id);
    this.warmQueue.push({ persona, sessionId });
    if (!this.warming) void this.drainWarmQueue();
  }

  private async drainWarmQueue(): Promise<void> {
    this.warming = true;
    try {
      while (!this.stopped) {
        const next = this.warmQueue.shift();
        if (!next) break;
        let fresh = 0;
        for (const line of coreLines(next.persona)) {
          if (this.stopped) return;
          if (this.usedToday() + line.length > this.cfg.dailyChars) {
            this.logger.info("voice", "prewarm", next.persona.name, "stopped at the daily cap");
            this.warmQueue = [];
            return;
          }
          const r = await this.render(line, next.persona, next.sessionId);
          if (!r.ok) {
            this.logger.info("voice", "prewarm", next.persona.name, `stopped: ${r.reason}`);
            break;
          }
          if (!r.cached) fresh++;
        }
        if (fresh) this.logger.info("voice", "prewarm", next.persona.name, `${fresh} line(s)`);
      }
    } catch (err) {
      this.logger.info("voice", "prewarm error", String(err).slice(0, 120));
    } finally {
      this.warming = false;
    }
  }

  /** Test seam: resolves once background prewarm has drained. */
  async idle(): Promise<void> {
    while (this.warming || this.inflight.size) await Bun.sleep(5);
  }
}

/**
 * KEY=value lines; blank lines and # comments skipped, optional `export `, optional matching
 * quotes. Only names the hub honours are kept (ELEVENLABS_API_KEY for now).
 */
export function parseSecrets(text: string): { ELEVENLABS_API_KEY?: string } {
  const out: { ELEVENLABS_API_KEY?: string } = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] ?? "").trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2)
      value = value.slice(1, -1);
    if (m[1] === "ELEVENLABS_API_KEY" && value) out.ELEVENLABS_API_KEY = value;
  }
  return out;
}

function failAssign(
  status: number,
  reason: SpeakFailure["reason"],
  error: string,
): { ok: false; status: number } & SpeakFailure {
  return { ok: false, status, reason, error };
}

function fail(status: number, reason: SpeakFailure["reason"], error: string): SpeakResult {
  return { ok: false, status, reason, error };
}

function readCached(file: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const buf = fs.readFileSync(file);
    if (buf.byteLength === 0) return undefined;
    const now = new Date();
    fs.utimesSync(file, now, now);
    return new Uint8Array(buf);
  } catch {
    return undefined;
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** Local calendar day, so the cap resets at the operator's midnight. */
export function localDay(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
