/**
 * Wire a project into mission control, or take it out again. The library behind
 * `amc wire` / `amc unwire` (commands.ts is the CLI side).
 *
 * With --dry-run it prints what it would add. Otherwise it merges in place:
 * existing hooks, env and servers are kept, only entries pointing at our hub are
 * replaced, and the CLAUDE.md snippet is appended between marker comments.
 *
 * Shared (default): hooks + env -> .claude/settings.json, MCP server -> .mcp.json,
 * snippet -> CLAUDE.md. These are usually committed, so we warn when one is tracked.
 *
 * --local: hooks + env -> .claude/settings.local.json, MCP server -> local scope
 * (`claude mcp add-json --scope local`, stored in ~/.claude.json under the project
 * path), snippet -> CLAUDE.local.md, and both local files are added to
 * .git/info/exclude unless already ignored. Nothing tracked by git is touched.
 *
 * --unwire removes only our entries from all of the above, whichever mode wrote
 * them, and deletes files that end up empty.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Every lifecycle event we report. PermissionRequest fires the instant a prompt
 * would appear (the permission_prompt Notification lags by ~6s), so it is
 * reported even without the gate. SubagentStart/SubagentStop and the agent-team
 * events feed the crew bay; hooks fired inside a subagent carry agent_id.
 */
export const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Notification",
  "PermissionRequest",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
] as const;

/**
 * AskUserQuestion and ExitPlanMode are Claude Code's own "ask the human" prompts;
 * routed through the gate they are answered on the board (questions, plan approval).
 */
export const QUESTION_GATE_MATCHER = "AskUserQuestion|ExitPlanMode";
export const DEFAULT_GATE_MATCHER = `Bash|Write|Edit|MultiEdit|NotebookEdit|${QUESTION_GATE_MATCHER}`;
/** Every hook command we write posts here; unwire keys off it, whatever the port. */
export const MARKER = "/api/hooks/";
export const MCP_SERVER_NAME = "mission-control";
export const SNIPPET_START = "<!-- mission-control:start -->";
export const SNIPPET_END = "<!-- mission-control:end -->";
/** Snippets written before the markers existed are recognised by this heading. */
const LEGACY_SNIPPET_HEADING = "## Decisions go through Mission Control";
const EXCLUDE_START = "# mission-control:start (removed by amc unwire)";
/** What wire.ts wrote before the amc CLI existed; unwire still recognises it. */
const LEGACY_EXCLUDE_START = "# mission-control:start (removed by bun scripts/wire.ts --unwire)";
const EXCLUDE_END = "# mission-control:end";

/**
 * Gate timing, all in seconds, must stay ordered: hub AMC_GATE_TIMEOUT_MS (540s)
 * < curl -m (590) < hook timeout (600). A PreToolUse hook that times out skips
 * the tool call instead of prompting, so the hub must always answer first.
 */
const GATE_HOOK_TIMEOUT_S = 600;
export const GATE_CURL_TIMEOUT_S = 590;

export const AUTO_BACKGROUND_KEY = "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS";
/** Settings env applies to every session in the project. */
export const SETTINGS_ENV = {
  // A main-conversation MCP call still running after 2 min is otherwise moved to a
  // background task and Claude carries on without the answer.
  [AUTO_BACKGROUND_KEY]: "0",
};

/**
 * --telemetry: OTLP/HTTP JSON export to the hub, which feeds token and cost
 * counters and activity. Prompt and tool-detail logging stay off on purpose:
 * the hub reads card context from transcripts and does not need the text twice.
 */
export function telemetryEnv(hubUrl: string): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: hubUrl,
    OTEL_METRIC_EXPORT_INTERVAL: "10000",
    OTEL_LOGS_EXPORT_INTERVAL: "2000",
  };
}

/** Keys that decide where telemetry goes: a different value means someone else's collector. */
const TELEMETRY_ROUTING = [
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
];
/** Present at all, these override the endpoint per signal. */
const TELEMETRY_OVERRIDES = [
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
];
/** The hub on loopback, any port: how unwire recognises an endpoint we wrote. */
const OUR_ENDPOINT = /^http:\/\/127\.0\.0\.1:\d+\/?$/;

/**
 * Adds our telemetry keys that are missing; keys already set to the same value
 * or to a harmless different one (an interval) are left alone. Refuses when an
 * existing setting routes telemetry elsewhere, since that is the user's own
 * collector and silently redirecting it would break it.
 */
export function mergeTelemetry(
  env: Record<string, string>,
  hubUrl: string,
  sources: { file: string; env: Record<string, string> }[],
): Record<string, string> {
  const ours = telemetryEnv(hubUrl);
  const conflicts: string[] = [];
  for (const { file, env: e } of sources) {
    for (const k of TELEMETRY_ROUTING) {
      if (e[k] !== undefined && e[k] !== ours[k]) conflicts.push(`${k}=${e[k]} in ${file}`);
    }
    for (const k of TELEMETRY_OVERRIDES) {
      if (e[k] !== undefined) conflicts.push(`${k}=${e[k]} in ${file}`);
    }
  }
  if (conflicts.length) {
    throw new Error(
      `Refusing --telemetry: telemetry is already sent elsewhere:\n  ${conflicts.join("\n  ")}\nRemove those settings or wire without --telemetry.`,
    );
  }
  const out = { ...env };
  for (const [k, v] of Object.entries(ours)) if (out[k] === undefined) out[k] = v;
  return out;
}

/** Inverse of mergeTelemetry: only when the endpoint is the hub, only keys still at our values. */
function stripTelemetry(env: Record<string, string>): string[] {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || !OUR_ENDPOINT.test(endpoint)) return [];
  const ours = telemetryEnv(endpoint);
  const removed: string[] = [];
  for (const [k, v] of Object.entries(ours)) {
    if (env[k] === v) {
      delete env[k];
      removed.push(k);
    }
  }
  return removed;
}

interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
  statusMessage?: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}
type HooksConfig = Record<string, HookGroup[]>;

export interface WireOptions {
  dir: string;
  hubUrl: string;
  gate: boolean;
  gateMatcher: string;
  /** How Claude Code launches the MCP server: the amc binary + ["mcp"] (see self.ts). */
  mcp: McpCommand;
  local: boolean;
  /** Also point Claude Code's OpenTelemetry export at the hub (see telemetryEnv). */
  telemetry?: boolean;
}

/** Local-scope MCP servers live in ~/.claude.json; only the claude CLI should write that file. */
export interface LocalMcp {
  has(dir: string, name: string): boolean;
  add(dir: string, name: string, entry: unknown): void;
  remove(dir: string, name: string): void;
}

export interface WireDeps {
  localMcp: LocalMcp;
  /** The Claude config dir (default: claudeHome()); a "project" whose .claude is this dir is refused. */
  claudeHome?: string;
}

/** Where user-level settings live: --home / AMC_CLAUDE_HOME, else CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeHome(override?: string): string {
  return path.resolve(
    override ??
      process.env.AMC_CLAUDE_HOME ??
      process.env.CLAUDE_CONFIG_DIR ??
      path.join(os.homedir(), ".claude"),
  );
}

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * True when <dir>/.claude is the Claude config dir itself (dir is usually $HOME).
 * Its settings.json is the user settings file, so per-project wire/unwire must
 * not treat it as a project: that is --global's file.
 */
export function isClaudeHomeProject(dir: string, home: string): boolean {
  return real(path.join(dir, ".claude")) === real(home);
}

/**
 * CLAUDE_PID is the claude process (2.1.214+); $PPID is the same thing on older
 * builds. The session id and messaging socket ride along as headers so the hub
 * can correlate and, later, nudge the session.
 */
const HEADERS =
  `-H "X-Claude-Pid: \${CLAUDE_PID:-$PPID}" -H "X-Claude-Session: $CLAUDE_CODE_SESSION_ID" ` +
  `-H "X-Claude-Socket: $CLAUDE_CODE_MESSAGING_SOCKET" -H 'Content-Type: application/json'`;

/**
 * SessionStart only: the claude process's parent pid. The hub walks upward from
 * it to spot a `claude` started underneath another live session (nothing in the
 * env links them). One `ps` per session start is cheap; per tool call it is not.
 */
const PPID_HEADER = `-H "X-Claude-Ppid: $(ps -o ppid= -p \${CLAUDE_PID:-$PPID} | tr -d ' ')"`;

/**
 * The session's messaging-socket token, needed to deliver prose answers back
 * into it (see apps/hub/src/socket.ts). Only on SessionStart and Stop, the two
 * hooks that establish and refresh it; the hub never logs or displays it.
 */
const TOKEN_HEADER = `-H "X-Claude-Token: $CLAUDE_CODE_MESSAGING_TOKEN"`;

export function reporterCommand(hubUrl: string, event: string): string {
  // SessionEnd hooks share a 1.5s budget by default, so keep that one snappy.
  const m = event === "SessionEnd" ? 1 : 3;
  const headers = event === "SessionStart" ? `${HEADERS} ${TOKEN_HEADER} ${PPID_HEADER}` : HEADERS;
  return `curl -sS -m ${m} -X POST ${headers} --data-binary @- ${hubUrl}${MARKER}${event} >/dev/null 2>&1 || true`;
}

/**
 * Stop is the one reporter Claude Code must read: the hub may answer
 * {"decision":"block","reason":...} to nudge prose questions into AskUserQuestion.
 * -f prints nothing on an HTTP error, stderr is discarded, and `|| true` keeps
 * a dead hub from failing the hook, so the fallback is always "just stop".
 */
export function stopCommand(hubUrl: string): string {
  return `curl -sSf -m 3 -X POST ${HEADERS} ${TOKEN_HEADER} --data-binary @- ${hubUrl}${MARKER}stop 2>/dev/null || true`;
}

export function gateCommand(hubUrl: string): string {
  // No `|| true` and no output redirect: Claude Code reads the JSON we print.
  return `curl -sS -m ${GATE_CURL_TIMEOUT_S} -X POST ${HEADERS} --data-binary @- ${hubUrl}${MARKER}gate`;
}

export function buildHooks(
  opts: Pick<WireOptions, "hubUrl" | "gate" | "gateMatcher">,
): HooksConfig {
  const hooks: HooksConfig = {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = [
      {
        hooks: [
          {
            type: "command",
            command:
              event === "Stop" ? stopCommand(opts.hubUrl) : reporterCommand(opts.hubUrl, event),
            timeout: event === "SessionEnd" ? 2 : 5,
          },
        ],
      },
    ];
  }
  if (opts.gate) {
    // PermissionRequest only fires when Claude Code would prompt, and an empty
    // reply from the hub leaves the normal terminal prompt in place.
    hooks.PermissionRequest?.push({
      matcher: opts.gateMatcher,
      hooks: [
        {
          type: "command",
          command: gateCommand(opts.hubUrl),
          timeout: GATE_HOOK_TIMEOUT_S,
          statusMessage: "Waiting for Mission Control",
        },
      ],
    });
  }
  return hooks;
}

export interface McpCommand {
  command: string;
  args: string[];
}

/** Per-server tool timeout (ms). Also floors the stdio idle timeout, so a decision can wait all day. */
export const MCP_TIMEOUT_MS = 86_400_000;

export function buildMcpEntry(opts: Pick<WireOptions, "hubUrl" | "mcp">) {
  return {
    type: "stdio",
    command: opts.mcp.command,
    args: opts.mcp.args,
    env: { AMC_HUB_URL: opts.hubUrl },
    timeout: MCP_TIMEOUT_MS,
  };
}

function isOurs(group: HookGroup): boolean {
  return (
    group.hooks.length > 0 &&
    group.hooks.every((h) => typeof h.command === "string" && h.command.includes(MARKER))
  );
}

/** Merge: drop any existing groups that are ours, keep everything else, append fresh ones. */
export function mergeHooks(existing: HooksConfig | undefined, ours: HooksConfig): HooksConfig {
  const out: HooksConfig = {};
  const events = new Set([...Object.keys(existing ?? {}), ...Object.keys(ours)]);
  for (const event of events) {
    const kept = (existing?.[event] ?? []).filter((g) => !isOurs(g));
    out[event] = [...kept, ...(ours[event] ?? [])];
  }
  return out;
}

/** Inverse of mergeHooks: strips every hook command aimed at a hub, drops what ends up empty. */
export function stripHooks(existing: HooksConfig): { hooks: HooksConfig; removed: number } {
  const out: HooksConfig = {};
  let removed = 0;
  for (const [event, groups] of Object.entries(existing)) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept: HookGroup[] = [];
    for (const g of groups) {
      const hooks = (g.hooks ?? []).filter(
        (h) => !(typeof h.command === "string" && h.command.includes(MARKER)),
      );
      removed += (g.hooks?.length ?? 0) - hooks.length;
      if (hooks.length === (g.hooks?.length ?? 0)) kept.push(g);
      else if (hooks.length > 0) kept.push({ ...g, hooks });
    }
    if (kept.length > 0 || groups.length === 0) out[event] = kept;
  }
  return { hooks: out, removed };
}

// ─── files ────────────────────────────────────────────────────────────────

export interface JsonFile {
  data: Record<string, unknown>;
  existed: boolean;
  /** Written back in the file's own style so an unwire can restore it byte-for-byte. */
  indent: string;
  trailingNewline: boolean;
}

export function readJson(file: string): JsonFile {
  const base = { data: {}, existed: false, indent: "  ", trailingNewline: true };
  if (!fs.existsSync(file)) return base;
  const text = fs.readFileSync(file, "utf8");
  if (!text.trim()) return { ...base, existed: true };
  try {
    return {
      data: JSON.parse(text) as Record<string, unknown>,
      existed: true,
      indent: text.match(/^[{[]\r?\n([ \t]+)/)?.[1] ?? "  ",
      trailingNewline: text.endsWith("\n"),
    };
  } catch (err) {
    throw new Error(`${file} is not valid JSON, refusing to touch it: ${String(err)}`);
  }
}

/**
 * Unwire's writer. Older wire versions reformatted JSON on write (inline arrays
 * expanded), so if what is left equals the committed version, put the committed
 * bytes back rather than our re-serialisation of them.
 */
function writeJsonRestoring(file: string, f: JsonFile) {
  const dir = path.dirname(file);
  const committed = git(dir, ["show", `HEAD:./${path.basename(file)}`]);
  if (committed.ok) {
    try {
      if (JSON.stringify(JSON.parse(committed.raw)) === JSON.stringify(f.data)) {
        fs.writeFileSync(file, committed.raw);
        return;
      }
    } catch {
      // committed version is not JSON; fall through
    }
  }
  writeJson(file, f);
}

export function writeJson(file: string, f: JsonFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify(f.data, null, f.indent)}${f.trailingNewline ? "\n" : ""}`,
  );
}

/** Delete a file we emptied, and its .claude folder if that is now empty too. */
function removeFile(file: string) {
  fs.rmSync(file, { force: true });
  const parent = path.dirname(file);
  if (path.basename(parent) === ".claude" && fs.readdirSync(parent).length === 0) {
    fs.rmdirSync(parent);
  }
}

/**
 * Appends `block` so that removeBlock() can undo it exactly: one blank line
 * before it when the file ends with a newline, none for an empty file. A file
 * with no trailing newline gets two and comes back from unwire with one.
 */
function appendBlock(existing: string, block: string): string {
  const sep = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${sep}${block}`;
}

/** Cuts [start, end) out of text and removes the separator appendBlock added before it. */
function cut(text: string, start: number, end: number): string {
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (!after.trim()) {
    const trimmed = before.replace(/\n\n$/, "\n");
    return trimmed.trim() ? trimmed : "";
  }
  // Something follows (the user wrote below our block): keep one blank line between.
  return before + after.replace(/^\n+/, "");
}

/** Removes a start/end marked block (end line inclusive). Returns undefined if absent. */
export function removeBlock(text: string, start: string, end: string): string | undefined {
  const s = text.indexOf(start);
  if (s < 0) return undefined;
  const e = text.indexOf(end, s);
  if (e < 0) return undefined;
  let stop = e + end.length;
  if (text[stop] === "\n") stop++;
  return cut(text, s, stop);
}

/** The pre-marker snippet: its heading through the next heading of level 1 or 2, or EOF. */
function removeLegacySnippet(text: string): string | undefined {
  const s = text.indexOf(`${LEGACY_SNIPPET_HEADING}\n`);
  if (s < 0 || (s > 0 && text[s - 1] !== "\n")) return undefined;
  const rest = text.slice(s + LEGACY_SNIPPET_HEADING.length);
  const next = rest.search(/\n#{1,2} /);
  return cut(text, s, next < 0 ? text.length : s + LEGACY_SNIPPET_HEADING.length + next + 1);
}

export function snippetBlock(snippet: string): string {
  return `${SNIPPET_START}\n${snippet.trim()}\n${SNIPPET_END}\n`;
}

/** Appends the marked snippet (the text, not a path) once; an older unmarked copy also counts as present. */
export function appendSnippet(claudeMd: string, snippet: string): "appended" | "present" {
  const existing = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, "utf8") : "";
  if (existing.includes(SNIPPET_START) || existing.includes(LEGACY_SNIPPET_HEADING)) {
    return "present";
  }
  fs.writeFileSync(claudeMd, appendBlock(existing, snippetBlock(snippet)));
  return "appended";
}

function removeSnippet(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8");
  const next =
    removeBlock(text, SNIPPET_START, SNIPPET_END) ?? removeLegacySnippet(text) ?? undefined;
  if (next === undefined) return false;
  if (next.trim()) fs.writeFileSync(file, next);
  else removeFile(file);
  return true;
}

// ─── git ──────────────────────────────────────────────────────────────────

/** `out` is trimmed for plumbing answers; `raw` keeps file contents byte-exact. */
function git(dir: string, args: string[]): { ok: boolean; out: string; raw: string } {
  try {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], { stderr: "ignore" });
    const raw = r.stdout.toString();
    return { ok: r.exitCode === 0, out: raw.trim(), raw };
  } catch {
    return { ok: false, out: "", raw: "" };
  }
}

export function isTracked(dir: string, rel: string): boolean {
  return git(dir, ["ls-files", "--error-unmatch", "--", rel]).ok;
}

/**
 * CLAUDE.local.md and settings.local.json are meant to stay out of git, but
 * nothing ignores them for us when a script (not Claude Code) creates them.
 * .git/info/exclude is itself untracked, so this keeps --local invisible to git.
 */
function excludeLocalFiles(dir: string, rels: string[]): string | undefined {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  const excl = git(dir, ["rev-parse", "--git-path", "info/exclude"]);
  if (!top.ok || !excl.ok) return undefined;
  const excludeFile = path.resolve(dir, excl.out);
  const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
  if (existing.includes(EXCLUDE_START) || existing.includes(LEGACY_EXCLUDE_START)) return undefined;
  const missing = rels.filter((r) => !git(dir, ["check-ignore", "-q", "--no-index", r]).ok);
  if (missing.length === 0) return undefined;
  const fromTop = path.relative(fs.realpathSync(top.out), fs.realpathSync(dir));
  const lines = missing.map((r) => `/${path.posix.join(fromTop.split(path.sep).join("/"), r)}`);
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  fs.writeFileSync(
    excludeFile,
    appendBlock(existing, `${EXCLUDE_START}\n${lines.join("\n")}\n${EXCLUDE_END}\n`),
  );
  return excludeFile;
}

function unexcludeLocalFiles(dir: string): string | undefined {
  const excl = git(dir, ["rev-parse", "--git-path", "info/exclude"]);
  if (!excl.ok) return undefined;
  const excludeFile = path.resolve(dir, excl.out);
  if (!fs.existsSync(excludeFile)) return undefined;
  const text = fs.readFileSync(excludeFile, "utf8");
  const next =
    removeBlock(text, EXCLUDE_START, EXCLUDE_END) ??
    removeBlock(text, LEGACY_EXCLUDE_START, EXCLUDE_END);
  if (next === undefined) return undefined;
  fs.writeFileSync(excludeFile, next);
  return excludeFile;
}

// ─── MCP via the claude CLI (local and user scope) ──────────────────────

/** User-scope MCP servers (every project) live at the top level of ~/.claude.json. */
export interface UserMcp {
  has(name: string): boolean;
  add(name: string, entry: unknown): void;
  remove(name: string): void;
}

/**
 * The CLI keeps its config in $CLAUDE_CONFIG_DIR/.claude.json when that is set,
 * else ~/.claude.json. Passing `configDir` points the CLI at a different config
 * dir (tests, --home), so the real one is never touched.
 */
export function claudeJsonPath(configDir?: string): string {
  const dir = configDir ?? process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

export type ClaudeJson = {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
};

export function readClaudeJson(file: string): ClaudeJson {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ClaudeJson;
  } catch {
    return {};
  }
}

/**
 * `claude mcp add` has no timeout flag, but `add-json` keeps every field we pass
 * (verified on 2.1.280 for local and user scope: the 24h `timeout` lands in
 * .claude.json). Local scope is keyed by the CLI's working directory, so those
 * calls run with cwd = the project.
 */
export function claudeCli(configDir?: string): {
  local: LocalMcp;
  user: UserMcp;
  claudeJson: string;
} {
  const claudeJson = claudeJsonPath(configDir);
  const env = configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : process.env;
  const cli = (args: string[], cwd?: string) => {
    const r = Bun.spawnSync(["claude", "mcp", ...args], { cwd, env, stderr: "pipe" });
    if (r.exitCode !== 0) {
      throw new Error(`claude mcp ${args[0]} failed: ${r.stderr.toString().trim()}`);
    }
  };
  const local: LocalMcp = {
    has: (dir, name) =>
      Boolean(readClaudeJson(claudeJson).projects?.[fs.realpathSync(dir)]?.mcpServers?.[name]),
    add(dir, name, entry) {
      // add-json refuses to overwrite, so replace explicitly. The CLI may key the
      // project differently from our realpath (then add-json below reports it).
      if (local.has(dir, name)) {
        try {
          local.remove(dir, name);
        } catch {}
      }
      cli(["add-json", "--scope", "local", name, JSON.stringify(entry)], dir);
    },
    remove: (dir, name) => cli(["remove", "--scope", "local", name], dir),
  };
  const user: UserMcp = {
    has: (name) => Boolean(readClaudeJson(claudeJson).mcpServers?.[name]),
    add(name, entry) {
      if (user.has(name)) user.remove(name);
      cli(["add-json", "--scope", "user", name, JSON.stringify(entry)]);
    },
    remove: (name) => cli(["remove", "--scope", "user", name]),
  };
  return { local, user, claudeJson };
}

// ─── write / unwire ──────────────────────────────────────────────────────

export function targetPaths(dir: string, local: boolean) {
  return {
    settingsPath: path.join(dir, ".claude", local ? "settings.local.json" : "settings.json"),
    mcpPath: path.join(dir, ".mcp.json"),
    claudeMd: path.join(dir, local ? "CLAUDE.local.md" : "CLAUDE.md"),
  };
}

export interface WriteResult {
  settingsPath: string;
  /** .mcp.json path, or "local scope" for --local. */
  mcpTarget: string;
  claudeMd: string;
  snippet: "appended" | "present";
  excludeFile?: string;
  /** Tracked files we just wrote into (shared mode only). */
  trackedWarnings: string[];
}

export function write(opts: WireOptions, snippetText: string, deps: WireDeps): WriteResult {
  const { settingsPath, mcpPath, claudeMd } = targetPaths(opts.dir, opts.local);

  const settings = readJson(settingsPath);
  settings.data.hooks = mergeHooks(
    settings.data.hooks as HooksConfig | undefined,
    buildHooks(opts),
  );
  let env: Record<string, string> = {
    ...((settings.data.env as Record<string, string>) ?? {}),
    ...SETTINGS_ENV,
  };
  if (opts.telemetry) {
    // Project settings override the user's, so a collector configured there counts too.
    const userSettings = path.join(deps.claudeHome ?? claudeHome(), "settings.json");
    env = mergeTelemetry(env, opts.hubUrl, [
      { file: settingsPath, env: env },
      {
        file: userSettings,
        env: (readJson(userSettings).data.env as Record<string, string>) ?? {},
      },
    ]);
  }
  settings.data.env = env;
  writeJson(settingsPath, settings);

  let mcpTarget = mcpPath;
  if (opts.local) {
    deps.localMcp.add(opts.dir, MCP_SERVER_NAME, buildMcpEntry(opts));
    mcpTarget = `local scope (~/.claude.json, project ${opts.dir})`;
  } else {
    const mcp = readJson(mcpPath);
    mcp.data.mcpServers = {
      ...((mcp.data.mcpServers as Record<string, unknown>) ?? {}),
      [MCP_SERVER_NAME]: buildMcpEntry(opts),
    };
    writeJson(mcpPath, mcp);
  }

  const snippet = appendSnippet(claudeMd, snippetText);
  const excludeFile = opts.local
    ? excludeLocalFiles(opts.dir, ["CLAUDE.local.md", ".claude/settings.local.json"])
    : undefined;
  const trackedWarnings = opts.local
    ? []
    : [settingsPath, mcpPath, claudeMd].filter((f) =>
        isTracked(opts.dir, path.relative(opts.dir, f)),
      );
  return { settingsPath, mcpTarget, claudeMd, snippet, excludeFile, trackedWarnings };
}

/** Removes everything write() could have added, in either mode. Returns what it removed. */
/**
 * Removes our hooks and env key from one settings file. `beforeWrite` runs only
 * when something will change (the global path uses it to take a backup).
 */
function stripSettingsFile(
  settingsPath: string,
  opts: { deleteIfEmpty: boolean; beforeWrite?: () => void },
): string[] {
  if (!fs.existsSync(settingsPath)) return [];
  const removed: string[] = [];
  const f = readJson(settingsPath);
  if (f.data.hooks && typeof f.data.hooks === "object") {
    const { hooks, removed: n } = stripHooks(f.data.hooks as HooksConfig);
    if (n > 0) {
      removed.push(`${n} hook command(s) from ${settingsPath}`);
      if (Object.keys(hooks).length) f.data.hooks = hooks;
      else delete f.data.hooks;
    }
  }
  const env = f.data.env as Record<string, string> | undefined;
  // We only ever set it to "0"; any other value is the user's own choice.
  if (env?.[AUTO_BACKGROUND_KEY] === "0") {
    delete env[AUTO_BACKGROUND_KEY];
    if (Object.keys(env).length === 0) delete f.data.env;
    removed.push(`env ${AUTO_BACKGROUND_KEY} from ${settingsPath}`);
  }
  if (env) {
    const tel = stripTelemetry(env);
    if (tel.length) removed.push(`telemetry env (${tel.join(", ")}) from ${settingsPath}`);
    if (Object.keys(env).length === 0) delete f.data.env;
  }
  if (removed.length === 0) return removed;
  opts.beforeWrite?.();
  if (opts.deleteIfEmpty && Object.keys(f.data).length === 0) {
    removeFile(settingsPath);
    removed.push(`${settingsPath} (now empty, deleted)`);
  } else {
    writeJsonRestoring(settingsPath, f);
  }
  return removed;
}

export function unwire(dir: string, deps: WireDeps): string[] {
  if (isClaudeHomeProject(dir, deps.claudeHome ?? claudeHome())) {
    throw new Error(
      `${path.join(dir, ".claude")} is your Claude config dir, so its settings.json holds the global wiring. Use \`amc unwire --global\` to remove that.`,
    );
  }
  const removed: string[] = [];

  for (const local of [false, true]) {
    const { settingsPath, claudeMd } = targetPaths(dir, local);
    removed.push(...stripSettingsFile(settingsPath, { deleteIfEmpty: true }));
    if (removeSnippet(claudeMd)) {
      removed.push(
        `snippet from ${claudeMd}${fs.existsSync(claudeMd) ? "" : " (now empty, deleted)"}`,
      );
    }
  }

  const mcpPath = path.join(dir, ".mcp.json");
  if (fs.existsSync(mcpPath)) {
    const f = readJson(mcpPath);
    const servers = f.data.mcpServers as Record<string, unknown> | undefined;
    if (servers && MCP_SERVER_NAME in servers) {
      delete servers[MCP_SERVER_NAME];
      if (Object.keys(servers).length === 0) delete f.data.mcpServers;
      removed.push(`MCP server "${MCP_SERVER_NAME}" from ${mcpPath}`);
      if (Object.keys(f.data).length === 0) {
        removeFile(mcpPath);
        removed.push(`${mcpPath} (now empty, deleted)`);
      } else {
        writeJsonRestoring(mcpPath, f);
      }
    }
  }
  if (deps.localMcp.has(dir, MCP_SERVER_NAME)) {
    deps.localMcp.remove(dir, MCP_SERVER_NAME);
    removed.push(`MCP server "${MCP_SERVER_NAME}" from local scope (~/.claude.json)`);
  }

  const excludeFile = unexcludeLocalFiles(dir);
  if (excludeFile) removed.push(`ignore entries from ${excludeFile}`);
  return removed;
}

// ─── global (user-level) wiring ──────────────────────────────────────────

export interface GlobalDeps {
  userMcp: UserMcp;
  /** .claude.json to scan for projects that are also wired. */
  claudeJson: string;
}

export interface GlobalResult {
  settingsPath: string;
  backup?: string;
  claudeMd?: string;
  snippet?: "appended" | "present";
  alsoWired: ProjectWiring[];
}

export interface ProjectWiring {
  dir: string;
  where: string[];
}

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** settings.json.amc-backup-YYYYMMDD-HHMMSS next to the file; undefined if there was nothing to back up. */
function backupFile(file: string, now: Date): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const backup = `${file}.amc-backup-${stamp(now)}`;
  fs.copyFileSync(file, backup);
  return backup;
}

/**
 * Projects Claude Code knows about (the `projects` map in .claude.json) that
 * also carry our wiring. With global wiring on, those sessions would report
 * every event twice; the hub drops the duplicates, but unwiring them is cleaner.
 */
export function detectProjectWiring(claudeJson: string, home: string): ProjectWiring[] {
  const out: ProjectWiring[] = [];
  for (const [dir, cfg] of Object.entries(readClaudeJson(claudeJson).projects ?? {})) {
    // $HOME is often a "project" too, but its .claude/settings.json is the global file.
    if (isClaudeHomeProject(dir, home)) continue;
    const where: string[] = [];
    if (cfg?.mcpServers?.[MCP_SERVER_NAME]) where.push("local-scope MCP server");
    const mcp = path.join(dir, ".mcp.json");
    if (fs.existsSync(mcp) && fs.readFileSync(mcp, "utf8").includes(`"${MCP_SERVER_NAME}"`)) {
      where.push(".mcp.json");
    }
    for (const rel of [".claude/settings.json", ".claude/settings.local.json"]) {
      const f = path.join(dir, rel);
      if (fs.existsSync(f) && fs.readFileSync(f, "utf8").includes(MARKER)) where.push(rel);
    }
    if (where.length) out.push({ dir, where });
  }
  return out;
}

/**
 * Hooks + env into <claude home>/settings.json and the MCP server at user scope,
 * so every project on the machine reports in with no per-project files. User
 * hooks run in addition to project hooks (hooks merge across settings files).
 * The CLAUDE.md snippet is opt-in: global instructions reach every project.
 */
export function writeGlobal(
  opts: Pick<WireOptions, "hubUrl" | "gate" | "gateMatcher" | "mcp" | "telemetry">,
  home: string,
  snippetText: string | undefined,
  deps: GlobalDeps,
  now = new Date(),
): GlobalResult {
  const settingsPath = path.join(home, "settings.json");
  const backup = backupFile(settingsPath, now);
  const settings = readJson(settingsPath);
  settings.data.hooks = mergeHooks(
    settings.data.hooks as HooksConfig | undefined,
    buildHooks(opts),
  );
  let env: Record<string, string> = {
    ...((settings.data.env as Record<string, string>) ?? {}),
    ...SETTINGS_ENV,
  };
  if (opts.telemetry) env = mergeTelemetry(env, opts.hubUrl, [{ file: settingsPath, env }]);
  settings.data.env = env;
  writeJson(settingsPath, settings);
  deps.userMcp.add(MCP_SERVER_NAME, buildMcpEntry(opts));
  const claudeMd = snippetText ? path.join(home, "CLAUDE.md") : undefined;
  const snippet = claudeMd && snippetText ? appendSnippet(claudeMd, snippetText) : undefined;
  return {
    settingsPath,
    backup,
    claudeMd,
    snippet,
    alsoWired: detectProjectWiring(deps.claudeJson, home),
  };
}

/** Inverse of writeGlobal. settings.json is never deleted, only backed up and edited. */
export function unwireGlobal(
  home: string,
  deps: GlobalDeps,
  now = new Date(),
): { removed: string[]; backup?: string } {
  const settingsPath = path.join(home, "settings.json");
  let backup: string | undefined;
  const removed = stripSettingsFile(settingsPath, {
    deleteIfEmpty: false,
    beforeWrite: () => {
      backup = backupFile(settingsPath, now);
    },
  });
  if (deps.userMcp.has(MCP_SERVER_NAME)) {
    deps.userMcp.remove(MCP_SERVER_NAME);
    removed.push(`MCP server "${MCP_SERVER_NAME}" from user scope`);
  }
  const claudeMd = path.join(home, "CLAUDE.md");
  if (removeSnippet(claudeMd)) removed.push(`snippet from ${claudeMd}`);
  return { removed, backup };
}
