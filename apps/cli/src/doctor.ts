/**
 * `amc doctor`: one line per check, worst first in the exit code. Read-only:
 * it never writes a file or calls the claude CLI beyond `claude --version`.
 * Secrets are reported as configured yes/no and never printed.
 */
import fs from "node:fs";
import path from "node:path";
import type { VoiceStatus } from "@amc/shared";
import { loadConfig } from "../../hub/src/config";
import { parseSecrets } from "../../hub/src/tts";
import type { Io } from "./commands";
import { describeCommand, type EntryState, entryState } from "./migrate";
import {
  AUTO_BACKGROUND_KEY,
  isClaudeHomeProject,
  MARKER,
  MCP_SERVER_NAME,
  type McpCommand,
  readClaudeJson,
  targetPaths,
} from "./wire";

export type Level = "ok" | "info" | "warn" | "fail";

export interface Check {
  level: Level;
  text: string;
}

export interface DoctorEnv {
  version: string;
  /** This amc as Claude Code should launch it, and how to show it. */
  self: McpCommand;
  selfLabel: string;
  hubUrl: string;
  home: string;
  claudeJson: string;
  /** Project to check besides the global wiring. */
  dir: string;
  env: NodeJS.ProcessEnv;
  /** `claude --version`, or undefined when the CLI is missing. */
  claudeVersion(): string | undefined;
  fetch?: typeof fetch;
}

export function realClaudeVersion(): string | undefined {
  try {
    const r = Bun.spawnSync(["claude", "--version"], { stderr: "ignore", timeout: 10_000 });
    return r.exitCode === 0 ? r.stdout.toString().trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

function readSettings(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

interface HookSummary {
  count: number;
  gate?: string;
  ports: Set<string>;
}

function summariseHooks(settings: Record<string, unknown> | undefined): HookSummary {
  const out: HookSummary = { count: 0, ports: new Set() };
  const hooks = settings?.hooks as
    | Record<string, { matcher?: string; hooks?: { command?: string }[] }[]>
    | undefined;
  for (const groups of Object.values(hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of g.hooks ?? []) {
        if (typeof h.command !== "string" || !h.command.includes(MARKER)) continue;
        out.count++;
        const port = h.command.match(/127\.0\.0\.1:(\d+)\/api\/hooks\//)?.[1];
        if (port) out.ports.add(port);
        if (h.command.includes(`${MARKER}gate`)) out.gate = g.matcher ?? "*";
      }
    }
  }
  return out;
}

const STATE_TEXT: Record<EntryState, (e: unknown) => string> = {
  current: () => "points at this amc",
  "repo-path": (e) =>
    `points at a repo checkout (${describeCommand(e)}); run \`amc wire\` to migrate it`,
  "missing-binary": (e) => `points at a missing binary (${describeCommand(e)}); run \`amc wire\``,
  other: (e) => `points at ${describeCommand(e)}, not this amc`,
};

function mcpCheck(where: string, entry: unknown, self: McpCommand): Check {
  const state = entryState(entry, self);
  const level: Level = state === "current" ? "ok" : state === "missing-binary" ? "fail" : "warn";
  const timeout = (entry as { timeout?: number }).timeout;
  const t =
    timeout && timeout >= 86_400_000 ? "" : " (no 24h timeout: long decisions may be cut off)";
  return {
    level: t && level === "ok" ? "warn" : level,
    text: `MCP server, ${where}: ${STATE_TEXT[state](entry)}${t}`,
  };
}

function hookCheck(where: string, s: HookSummary, hubPort: string): Check[] {
  const out: Check[] = [];
  const otherPorts = [...s.ports].filter((p) => p !== hubPort);
  out.push({
    level: otherPorts.length ? "warn" : "ok",
    text: `hooks, ${where}: ${s.count} command(s)${otherPorts.length ? `, aimed at port ${otherPorts.join(", ")} but the hub is on ${hubPort}` : ""}`,
  });
  out.push({
    level: "info",
    text: `permission gate, ${where}: ${s.gate ? `on (/${s.gate}/)` : "off"}`,
  });
  return out;
}

function envChecks(
  where: string,
  env: Record<string, string> | undefined,
  hubUrl: string,
): Check[] {
  const out: Check[] = [];
  out.push(
    env?.[AUTO_BACKGROUND_KEY] === "0"
      ? { level: "ok", text: `${AUTO_BACKGROUND_KEY}=0, ${where}` }
      : {
          level: "warn",
          text: `${AUTO_BACKGROUND_KEY} is not 0 in ${where}: a decision waiting over 2 min gets backgrounded`,
        },
  );
  const endpoint = env?.OTEL_EXPORTER_OTLP_ENDPOINT;
  out.push(
    !endpoint
      ? {
          level: "info",
          text: `telemetry, ${where}: off (amc wire --telemetry for token and cost stats)`,
        }
      : endpoint.replace(/\/$/, "") === hubUrl
        ? { level: "ok", text: `telemetry, ${where}: exported to the hub` }
        : { level: "info", text: `telemetry, ${where}: exported to ${endpoint}, not the hub` },
  );
  return out;
}

type KeySource = "env" | "secrets.env" | null;

/** What secrets.env holds, as the hub would read it (0600 only). Never returns the key. */
function secretsFileState(file: string): "none" | "key" | "no-key" | "too-open" | "unreadable" {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return "none";
  }
  if (st.mode & 0o077) return "too-open";
  try {
    return parseSecrets(fs.readFileSync(file, "utf8")).ELEVENLABS_API_KEY ? "key" : "no-key";
  } catch {
    return "unreadable";
  }
}

/**
 * The running hub is the authority on which key it uses (its env may differ
 * from this shell's); without a hub, report what `amc start` from this shell
 * would pick up. Only ever says where a key comes from, never the key.
 */
function elevenLabs(
  env: NodeJS.ProcessEnv,
  dataDir: string,
  hub: { configured: boolean; keySource?: KeySource } | undefined,
): Check[] {
  const file = path.join(dataDir, "secrets.env");
  const fileState = secretsFileState(file);
  const shellKey = !!env.ELEVENLABS_API_KEY?.trim();
  const out: Check[] = [];
  if (hub) {
    const from =
      hub.keySource === "env"
        ? " (key from the hub's environment)"
        : hub.keySource === "secrets.env"
          ? ` (key from ${file})`
          : "";
    out.push({
      level: "info",
      text: `ElevenLabs voice (running hub): ${hub.configured ? `configured${from}` : "not configured, browser voice only"}`,
    });
  } else {
    const source = shellKey
      ? "ELEVENLABS_API_KEY in this shell"
      : fileState === "key"
        ? file
        : undefined;
    out.push({
      level: "info",
      text: `ElevenLabs voice (hub not running, from this shell): ${source ? `configured (${source})` : "not configured"}`,
    });
  }
  if (fileState === "too-open") {
    out.push({
      level: "warn",
      text: `ElevenLabs: ${file} is readable by others and is ignored; chmod 600 it`,
    });
  } else if (fileState === "unreadable") {
    out.push({ level: "warn", text: `ElevenLabs: could not read ${file}` });
  }
  if (shellKey && fileState !== "none") {
    out.push({
      level: "warn",
      text: `ElevenLabs: ELEVENLABS_API_KEY is exported in this shell and ${file} exists; a shell-exported key overrides secrets.env for hubs started from this shell`,
    });
  }
  return out;
}

export async function doctor(d: DoctorEnv): Promise<Check[]> {
  const checks: Check[] = [];
  const hubPort = new URL(d.hubUrl).port;
  checks.push({ level: "info", text: `amc ${d.version} (${d.selfLabel})` });

  // Hub
  const get = async <T>(p: string, timeoutMs = 2_000): Promise<{ ok: boolean; body: T }> => {
    const res = await (d.fetch ?? fetch)(`${d.hubUrl}${p}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, body: (await res.json()) as T };
  };
  let hubUp = false;
  try {
    const { ok, body } = await get<{ ok?: boolean; version?: string }>("/api/health");
    if (!ok || !body.ok) throw new Error("unhealthy");
    hubUp = true;
    const v = body.version ?? "unknown (older than 0.1.0)";
    checks.push(
      v === d.version
        ? { level: "ok", text: `hub reachable at ${d.hubUrl}, version ${v}` }
        : {
            level: "warn",
            text: `hub reachable at ${d.hubUrl} but runs version ${v}, this amc is ${d.version}; restart it with this amc`,
          },
    );
  } catch {
    checks.push({
      level: "fail",
      text: `hub not reachable at ${d.hubUrl}; start it with \`amc start\``,
    });
  }

  // Claude Code
  const cv = d.claudeVersion();
  checks.push(
    cv
      ? { level: "ok", text: `Claude Code ${cv}` }
      : { level: "warn", text: "Claude Code: `claude --version` failed (not on PATH?)" },
  );

  // Global wiring
  const cj = readClaudeJson(d.claudeJson);
  const globalSettingsPath = path.join(d.home, "settings.json");
  const globalSettings = readSettings(globalSettingsPath);
  const globalHooks = summariseHooks(globalSettings);
  const userEntry = cj.mcpServers?.[MCP_SERVER_NAME];
  const globalWired = globalHooks.count > 0 || !!userEntry;
  if (globalWired) {
    if (globalHooks.count > 0) checks.push(...hookCheck(globalSettingsPath, globalHooks, hubPort));
    else
      checks.push({
        level: "warn",
        text: `hooks, ${globalSettingsPath}: none (amc wire --global)`,
      });
    checks.push(
      userEntry
        ? mcpCheck("user scope", userEntry, d.self)
        : { level: "warn", text: "MCP server, user scope: missing (amc wire --global)" },
    );
    checks.push(
      ...envChecks(globalSettingsPath, globalSettings?.env as Record<string, string>, d.hubUrl),
    );
  } else {
    checks.push({ level: "info", text: `global wiring: none in ${d.home}` });
  }

  // This project
  const dir = path.resolve(d.dir);
  let projectWired = false;
  // Run from the home dir, <dir>/.claude is the Claude config dir: its settings.json
  // is the global file already checked above, not a project's (same rule as unwire).
  const settingsFiles = isClaudeHomeProject(dir, d.home) ? [] : [false, true];
  for (const local of settingsFiles) {
    const { settingsPath } = targetPaths(dir, local);
    const s = readSettings(settingsPath);
    const h = summariseHooks(s);
    if (h.count === 0) continue;
    projectWired = true;
    checks.push(...hookCheck(settingsPath, h, hubPort));
    checks.push(...envChecks(settingsPath, s?.env as Record<string, string>, d.hubUrl));
  }
  const projectMcp = readSettings(path.join(dir, ".mcp.json"))?.mcpServers as
    | Record<string, unknown>
    | undefined;
  if (projectMcp?.[MCP_SERVER_NAME]) {
    projectWired = true;
    checks.push(mcpCheck(path.join(dir, ".mcp.json"), projectMcp[MCP_SERVER_NAME], d.self));
  }
  const localEntry = cj.projects?.[realpath(dir)]?.mcpServers?.[MCP_SERVER_NAME];
  if (localEntry) {
    projectWired = true;
    checks.push(mcpCheck(`local scope (${dir})`, localEntry, d.self));
  }
  if (!projectWired) checks.push({ level: "info", text: `project wiring: none in ${dir}` });
  if (!globalWired && !projectWired) {
    checks.push({
      level: "fail",
      text: "not wired: run `amc wire --global --gate` (every project) or `amc wire <dir>`",
    });
  }

  // Stale repo-path wiring in other projects Claude Code knows about.
  const stale: string[] = [];
  for (const [pdir, cfg] of Object.entries(cj.projects ?? {})) {
    if (realpath(pdir) === realpath(dir)) continue;
    if (entryState(cfg?.mcpServers?.[MCP_SERVER_NAME] ?? {}, d.self) === "repo-path") {
      stale.push(`${pdir} (local scope)`);
    }
    const m = readSettings(path.join(pdir, ".mcp.json"))?.mcpServers as
      | Record<string, unknown>
      | undefined;
    if (m?.[MCP_SERVER_NAME] && entryState(m[MCP_SERVER_NAME], d.self) === "repo-path") {
      stale.push(`${path.join(pdir, ".mcp.json")}`);
    }
  }
  if (stale.length) {
    checks.push({
      level: "warn",
      text: `stale repo-path MCP wiring in ${stale.length} other place(s), \`amc wire\` migrates them:\n${stale.map((s) => `      ${s}`).join("\n")}`,
    });
  }

  // Hub-side settings (what `amc start` would use with this environment).
  const cfg = loadConfig(d.env);
  checks.push({
    level: "info",
    text: `socket replies: ${cfg.socketReply ? "on" : "off"} (AMC_SOCKET_REPLY), stop nudge: ${cfg.nudge ? "on" : "off"} (AMC_NUDGE)`,
  });
  checks.push({
    level: fs.existsSync(cfg.dataDir) ? "ok" : "info",
    text: `data dir ${cfg.dataDir}${fs.existsSync(cfg.dataDir) ? "" : " (created on first amc start)"}`,
  });
  let voice: { configured: boolean; keySource?: KeySource } | undefined;
  if (hubUp) {
    try {
      const { ok, body } = await get<VoiceStatus>("/api/voice/status", 10_000);
      if (ok) voice = body.providers.elevenlabs;
    } catch {
      // older hub or slow upstream: fall back to this shell's view
    }
  }
  checks.push(...elevenLabs(d.env, cfg.dataDir, voice));
  return checks;
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

const TAG: Record<Level, string> = { ok: " ok ", info: "info", warn: "WARN", fail: "FAIL" };

export function printChecks(checks: Check[], io: Io): number {
  for (const c of checks) io.out(`[${TAG[c.level]}] ${c.text}`);
  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  io.out(`\n${fails} failed, ${warns} warning(s)`);
  return fails ? 1 : 0;
}
