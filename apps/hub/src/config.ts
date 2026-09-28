import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_HUB_PORT } from "@amc/shared";
import { type LogLevel, parseLogLevel } from "./hublog";

export interface HubConfig {
  host: string;
  port: number;
  dataDir: string;
  /**
   * How long the permission gate waits for an operator before giving up. Must
   * stay under the hook's own timeout (command hooks default to 600s): a timed
   * out PreToolUse hook skips the tool instead of prompting. wire.ts sets the
   * hook to 600s and curl to 590s, so 540s leaves headroom.
   */
  gateTimeoutMs: number;
  /** Silence after which a session is flipped to offline. */
  offlineAfterMs: number;
  /**
   * A crew member (subagent / teammate) with no hook for this long and no stop
   * event is treated as done, so a killed one cannot pin its parent to "working".
   * A member waiting on a decision is exempt.
   */
  crewStaleMs: number;
  /**
   * A teammate on standby (between tasks) with no hook for this long is dropped
   * from the bay. AMC_TEAMMATE_STANDBY_MS, default 4h. Leaving the team or the
   * lead session ending removes it sooner.
   */
  teammateStandbyMs: number;
  /**
   * Claude Code's config dir, read (never written) for agent team rosters at
   * <claudeHome>/teams/<team>/config.json. AMC_CLAUDE_HOME, default ~/.claude.
   */
  claudeHome: string;
  /** Offline sessions older than this are dropped from /api/state (kept in the db). */
  dropOfflineAfterMs: number;
  /** Hard cap on a single long-poll on /api/decisions/:id/wait. */
  maxWaitMs: number;
  /** Origins allowed to call the API from a browser (Vite dev server). */
  corsOrigins: string[];
  /** AMC_LOG: quiet | info (default) | debug. See hublog.ts. */
  logLevel: LogLevel;
  /**
   * Absolute path prefixes whose sessions the hub ignores entirely (no station,
   * log, events or gate cards). AMC_IGNORE_CWD (comma-separated, ~ expanded)
   * wins over `ignoreCwd` in <dataDir>/config.json; default ~/.claude-mem, whose
   * background observer sessions otherwise flood a globally wired floor.
   */
  ignoreCwd: string[];
  /**
   * AMC_NUDGE=off disables the Stop nudge (blocking a turn that ends with prose
   * questions once, asking Claude to use AskUserQuestion). The read-only prose
   * card still appears.
   */
  nudge: boolean;
  /**
   * Deliver answers to prose cards into the session over its messaging socket
   * (socket.ts, undocumented interface). AMC_SOCKET_REPLY=on|off wins over
   * `socketReply` in config.json; default on.
   */
  socketReply: boolean;
  /** Optional ElevenLabs voice provider (tts.ts). */
  tts: TtsConfig;
}

export interface TtsConfig {
  /**
   * ELEVENLABS_API_KEY from the environment (never config.json). tts.ts falls back to
   * <dataDir>/secrets.env when unset. A secret: used only as the upstream request header, the
   * UI sees `configured`. Never log or serialise it.
   */
  apiKey?: string;
  /** AMC_ELEVENLABS_URL, default https://api.elevenlabs.io (tests point it at a fake). */
  baseUrl: string;
  /** AMC_ELEVENLABS_MODEL, default eleven_flash_v2_5 (low latency, half the credits per char). */
  model: string;
  /** AMC_TTS_DAILY_CHARS: characters sent upstream per local day; cache hits are free. */
  dailyChars: number;
  /** Cache size cap in bytes (<dataDir>/voice-cache, oldest-used evicted first). */
  cacheMaxBytes: number;
  /** Upstream request timeout. */
  timeoutMs: number;
  /** Render a persona's common lines in the background after its first spoken line. */
  prewarm: boolean;
}

function onOff(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return !["off", "0", "false", "no"].includes(v.trim().toLowerCase());
}

export const DEFAULT_IGNORE_CWD = ["~/.claude-mem"];

export function expandHome(p: string): string {
  const t = p.trim();
  if (t === "~") return os.homedir();
  if (t.startsWith("~/")) return path.join(os.homedir(), t.slice(2));
  return t;
}

/** <dataDir>/config.json, user-editable. Unknown keys are ignored; a broken file is reported and skipped. */
function readConfigFile(dataDir: string): { ignoreCwd?: unknown; socketReply?: unknown } {
  const file = path.join(dataDir, "config.json");
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as {
      ignoreCwd?: unknown;
      socketReply?: unknown;
    };
  } catch (err) {
    console.error(`[hub] ignoring unreadable ${file}: ${String(err)}`);
    return {};
  }
}

function ignoreList(env: NodeJS.ProcessEnv, dataDir: string): string[] {
  const fromEnv = env.AMC_IGNORE_CWD;
  const fromFile = readConfigFile(dataDir).ignoreCwd;
  const raw =
    fromEnv !== undefined
      ? fromEnv.split(",")
      : Array.isArray(fromFile)
        ? fromFile.filter((x): x is string => typeof x === "string")
        : DEFAULT_IGNORE_CWD;
  return raw
    .map(expandHome)
    .filter(Boolean)
    .map((p) => path.resolve(p));
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const dataDir = env.AMC_DATA_DIR ?? path.join(os.homedir(), ".agent-mission-control");
  return {
    host: env.AMC_HOST ?? "127.0.0.1",
    port: intEnv(env, "AMC_PORT", DEFAULT_HUB_PORT),
    dataDir,
    ignoreCwd: ignoreList(env, dataDir),
    nudge: env.AMC_NUDGE?.toLowerCase() !== "off",
    socketReply: onOff(env.AMC_SOCKET_REPLY) ?? readConfigFile(dataDir).socketReply !== false,
    gateTimeoutMs: intEnv(env, "AMC_GATE_TIMEOUT_MS", 540_000),
    offlineAfterMs: intEnv(env, "AMC_OFFLINE_AFTER_MS", 30 * 60_000),
    crewStaleMs: intEnv(env, "AMC_CREW_STALE_MS", 10 * 60_000),
    teammateStandbyMs: intEnv(env, "AMC_TEAMMATE_STANDBY_MS", 4 * 60 * 60_000),
    claudeHome: path.resolve(expandHome(env.AMC_CLAUDE_HOME ?? "~/.claude")),
    dropOfflineAfterMs: intEnv(env, "AMC_DROP_OFFLINE_AFTER_MS", 24 * 60 * 60_000),
    maxWaitMs: 30_000,
    tts: {
      ...(env.ELEVENLABS_API_KEY?.trim() ? { apiKey: env.ELEVENLABS_API_KEY.trim() } : {}),
      baseUrl: (env.AMC_ELEVENLABS_URL?.trim() || "https://api.elevenlabs.io").replace(/\/+$/, ""),
      model: env.AMC_ELEVENLABS_MODEL?.trim() || "eleven_flash_v2_5",
      dailyChars: intEnv(env, "AMC_TTS_DAILY_CHARS", 20_000),
      cacheMaxBytes: 50 * 1024 * 1024,
      timeoutMs: 8_000,
      prewarm: env.AMC_TTS_PREWARM?.toLowerCase() !== "off",
    },
    corsOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
    // AMC_DEBUG=1 is an alias for AMC_LOG=debug.
    logLevel: parseLogLevel(
      env.AMC_LOG ?? (env.AMC_DEBUG === "1" || env.AMC_DEBUG === "true" ? "debug" : undefined),
    ),
  };
}
