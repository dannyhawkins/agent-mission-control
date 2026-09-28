/** amc's argument grammar: `amc <command> [positional...] [--flag] [--key value | --key=value]`. */

export type Command = "start" | "wire" | "unwire" | "mcp" | "doctor" | "version" | "help";

const VALUE_FLAGS = new Set(["--port", "--home", "--gate-matcher"]);

/** Flags each command accepts; anything else is a usage error, not silently ignored. */
const ALLOWED: Record<Command, string[]> = {
  start: ["--port"],
  wire: [
    "--global",
    "--local",
    "--gate",
    "--gate-questions-only",
    "--gate-matcher",
    "--telemetry",
    "--snippet",
    "--dry-run",
    "--force",
    "--port",
    "--home",
  ],
  unwire: ["--global", "--home"],
  mcp: [],
  doctor: ["--port", "--home"],
  version: [],
  help: [],
};

/** How many positionals each command takes (wire/unwire: a project dir; help: a command). */
const MAX_POSITIONAL: Record<Command, number> = {
  start: 0,
  wire: 1,
  unwire: 1,
  mcp: 0,
  doctor: 1,
  version: 0,
  help: 1,
};

export interface ParsedArgs {
  command: Command;
  positional: string[];
  flags: Set<string>;
  values: Record<string, string>;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const positional: string[] = [];
  let command: Command | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--version" || a === "-v" || a === "-V") {
      command ??= "version";
      continue;
    }
    if (a === "--help" || a === "-h") {
      // `amc wire --help` is help for wire.
      if (command && command !== "help") positional.unshift(command);
      command = "help";
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (VALUE_FLAGS.has(name)) {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined || v === "") throw new UsageError(`${name} needs a value`);
        values[name] = v;
      } else if (eq > 0) {
        throw new UsageError(`${name} does not take a value`);
      } else {
        flags.add(name);
      }
      continue;
    }
    if (a.startsWith("-") && a !== "-") throw new UsageError(`unknown option ${a}`);
    if (!command) {
      if (!(a in ALLOWED)) throw new UsageError(`unknown command "${a}"`);
      command = a as Command;
    } else {
      positional.push(a);
    }
  }

  command ??= "help";
  const allowed = ALLOWED[command];
  for (const f of [...flags, ...Object.keys(values)]) {
    if (!allowed.includes(f)) throw new UsageError(`amc ${command} does not take ${f}`);
  }
  if (positional.length > MAX_POSITIONAL[command]) {
    throw new UsageError(`amc ${command}: unexpected argument "${positional.at(-1)}"`);
  }
  if (flags.has("--gate") && flags.has("--gate-questions-only")) {
    throw new UsageError("--gate and --gate-questions-only are alternatives, pick one");
  }
  if (flags.has("--global") && flags.has("--local")) {
    throw new UsageError("--local is for a project; --global wires every project");
  }
  if (flags.has("--global") && positional.length && command !== "help") {
    throw new UsageError(`amc ${command} --global takes no directory`);
  }
  const port = values["--port"];
  if (port !== undefined) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65_535) {
      throw new UsageError(`--port must be 1-65535, got ${port}`);
    }
  }
  return { command, positional, flags, values };
}

export const HELP: Record<Command | "main", string> = {
  main: `amc: Agent Mission Control

Usage: amc <command> [options]

Commands:
  start     Run the hub and its UI on http://127.0.0.1:4242
  wire      Wire Claude Code into the hub (one project, or --global for all)
  unwire    Remove the wiring again
  doctor    Check the hub, the wiring and the environment
  mcp       The stdio MCP server Claude Code launches (not for humans)
  version   Print the version (also --version)
  help      This text, or \`amc help <command>\`

Data lives in ~/.agent-mission-control (AMC_DATA_DIR).`,
  start: `amc start [--port 4242]

Runs the hub (hooks, decisions, OTLP, WebSocket) serving the embedded UI.
Honours every AMC_* variable and <data dir>/secrets.env. Ctrl-C stops it and
hands open permission prompts back to their terminals.`,
  wire: `amc wire [dir] [--gate | --gate-questions-only] [--telemetry] [--local] [--force]
amc wire --global [--gate | --gate-questions-only] [--telemetry] [--snippet]

Merges hooks + env into Claude Code settings, registers the MCP server
(pointing at this amc) and, per project, appends the CLAUDE.md snippet.
Idempotent. Existing wiring that points at a repo checkout is migrated.

  --global               ~/.claude/settings.json + user-scope MCP (every project)
  --local                project, but only untracked files and local MCP scope
  --gate                 answer permission prompts, questions and plans on the board
  --gate-questions-only  only AskUserQuestion and plan approval
  --gate-matcher <re>    custom PermissionRequest matcher
  --telemetry            export Claude Code OpenTelemetry to the hub
  --snippet              with --global: also append the snippet to ~/.claude/CLAUDE.md
  --dry-run              print what would be written, change nothing
  --port <n>             hub port (default 4242 or AMC_PORT)
  --home <dir>           Claude config dir (default ~/.claude, AMC_CLAUDE_HOME)`,
  unwire: `amc unwire [dir]
amc unwire --global [--home <dir>]

Removes only what wire added (hooks, env, MCP server, snippet), in either mode.`,
  mcp: `amc mcp

The stdio MCP server (request_decision, report_status). Claude Code starts it;
AMC_HUB_URL points it at the hub.`,
  doctor: `amc doctor [dir] [--port 4242] [--home <dir>]

Checks the hub, this binary's version, the global and project wiring (flags
wiring that still points at a repo checkout), Claude Code's version, the
socket/telemetry settings and whether an ElevenLabs key is configured.`,
  version: "amc version | amc --version",
  help: "amc help [command]",
};
