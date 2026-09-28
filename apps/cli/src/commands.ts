/** `amc wire` and `amc unwire`: flags in, files changed, a report out. */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_HUB_PORT } from "@amc/shared";
import type { ParsedArgs } from "./args";
import { describeCommand, migrateMcpEntries } from "./migrate";
import {
  buildHooks,
  buildMcpEntry,
  claudeCli,
  claudeHome,
  DEFAULT_GATE_MATCHER,
  GATE_CURL_TIMEOUT_S,
  type LocalMcp,
  MCP_SERVER_NAME,
  type McpCommand,
  QUESTION_GATE_MATCHER,
  SETTINGS_ENV,
  snippetBlock,
  targetPaths,
  type UserMcp,
  unwire,
  unwireGlobal,
  type WireOptions,
  write,
  writeGlobal,
} from "./wire";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export const consoleIo: Io = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
};

/** Everything that touches the machine outside the target dir, injectable for tests. */
export interface WireEnv {
  /** Claude config dir (settings.json, CLAUDE.md for --global). */
  home: string;
  claudeJson: string;
  userMcp: UserMcp;
  localMcp: LocalMcp;
  /** How Claude Code should launch the MCP server (this amc). */
  mcp: McpCommand;
  snippet: string;
  cwd: string;
}

/** Real environment: --home / AMC_CLAUDE_HOME stand in for ~/.claude, and the claude CLI follows. */
export function realWireEnv(
  args: ParsedArgs,
  mcp: McpCommand,
  snippet: string,
  env = process.env,
): WireEnv {
  const override = args.values["--home"] ?? env.AMC_CLAUDE_HOME;
  const home = claudeHome(override);
  const cli = claudeCli(override ? home : undefined);
  return {
    home,
    claudeJson: cli.claudeJson,
    userMcp: cli.user,
    localMcp: cli.local,
    mcp,
    snippet,
    cwd: process.cwd(),
  };
}

export function hubUrlFor(args: ParsedArgs, env = process.env): string {
  const port = Number(args.values["--port"] ?? env.AMC_PORT ?? DEFAULT_HUB_PORT);
  return `http://127.0.0.1:${port}`;
}

/** The mission control checkout itself: wiring it would make a session editing the hub report to it. */
export function isMissionControlRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, "packages", "mcp-server", "CLAUDE_SNIPPET.md"));
}

function gateFlagOf(args: ParsedArgs): string {
  if (args.flags.has("--gate-questions-only")) return " --gate-questions-only";
  return args.flags.has("--gate") ? " --gate" : "";
}

function reportMigration(io: Io, w: WireEnv, extraDirs: string[]) {
  const { changed, skipped } = migrateMcpEntries(w.mcp, {
    userMcp: w.userMcp,
    localMcp: w.localMcp,
    claudeJson: w.claudeJson,
    extraDirs,
  });
  if (changed.length) {
    io.out("\nMigrated MCP wiring that pointed at a repo checkout:");
    for (const c of changed) io.out(`  ${c.where}\n    was ${c.from}\n    now ${c.to}`);
  }
  for (const s of skipped) io.err(`could not migrate ${s}`);
}

export function runWire(args: ParsedArgs, io: Io, w: WireEnv, env = process.env): number {
  const hubUrl = hubUrlFor(args, env);
  const dir = path.resolve(w.cwd, args.positional[0] ?? ".");
  const gate = args.flags.has("--gate") || args.flags.has("--gate-questions-only");
  const opts: WireOptions = {
    dir,
    hubUrl,
    gate,
    // --gate-questions-only: AskUserQuestion + plan approval on the board, tool permissions stay in the terminal.
    gateMatcher:
      args.values["--gate-matcher"] ??
      (args.flags.has("--gate-questions-only") ? QUESTION_GATE_MATCHER : DEFAULT_GATE_MATCHER),
    mcp: w.mcp,
    local: args.flags.has("--local"),
    telemetry: args.flags.has("--telemetry"),
  };
  const dryRun = args.flags.has("--dry-run");
  const mcpEntry = buildMcpEntry(opts);

  if (args.flags.has("--global")) {
    if (dryRun) {
      io.out(`# ${path.join(w.home, "settings.json")}  (merge the "hooks" and "env" keys)`);
      io.out(JSON.stringify({ hooks: buildHooks(opts), env: SETTINGS_ENV }, null, 2));
      io.out("\n# MCP server, user scope");
      io.out(`claude mcp add-json --scope user ${MCP_SERVER_NAME} '${JSON.stringify(mcpEntry)}'`);
      io.out(`\n# Or do it for me: amc wire --global${gateFlagOf(args)}`);
      return 0;
    }
    const r = writeGlobal(opts, w.home, args.flags.has("--snippet") ? w.snippet : undefined, {
      userMcp: w.userMcp,
      claudeJson: w.claudeJson,
    });
    if (r.backup) io.out(`backup: ${r.backup}`);
    io.out(`wrote hooks + env -> ${r.settingsPath}`);
    io.out(`wrote MCP server  -> user scope (${w.claudeJson}): ${describeCommand(mcpEntry)}`);
    if (r.claudeMd) {
      io.out(
        r.snippet === "appended"
          ? `appended snippet  -> ${r.claudeMd}`
          : `snippet already in   ${r.claudeMd}`,
      );
    }
    reportMigration(io, w, []);
    if (r.alsoWired.length) {
      io.err(
        `\nWarning: these projects are also wired per project, so their sessions send every event twice (the hub drops the duplicates, but the files are redundant now):\n${r.alsoWired
          .map((p) => `  ${p.dir}  (${p.where.join(", ")})\n    amc unwire ${p.dir}`)
          .join("\n")}`,
      );
    }
    if (opts.gate)
      io.out(`\nGate enabled for tools matching /${opts.gateMatcher}/ in every project.`);
    io.out("\nRestart running Claude Code sessions to pick up the hooks and MCP server.");
    return 0;
  }

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    io.err(`not a directory: ${dir}`);
    return 1;
  }
  if (isMissionControlRepo(dir) && !args.flags.has("--force")) {
    io.err(
      "Refusing to wire the mission control repo into itself (a Claude session editing the hub would report to the hub it is editing). Pass --force if you really want that.",
    );
    return 1;
  }

  const paths = targetPaths(dir, opts.local);
  if (dryRun) {
    io.out(`# ${paths.settingsPath}  (merge the "hooks" and "env" keys)`);
    io.out(JSON.stringify({ hooks: buildHooks(opts), env: SETTINGS_ENV }, null, 2));
    if (opts.local) {
      io.out(`\n# MCP server, local scope (run from ${dir})`);
      io.out(`claude mcp add-json --scope local ${MCP_SERVER_NAME} '${JSON.stringify(mcpEntry)}'`);
    } else {
      io.out(`\n# ${paths.mcpPath}  (merge the "mcpServers" key)`);
      io.out(JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: mcpEntry } }, null, 2));
    }
    io.out(`\n# ${paths.claudeMd}  (append)`);
    io.out(snippetBlock(w.snippet));
    io.out(`# Or do it for me: amc wire ${dir}${opts.local ? " --local" : ""}${gateFlagOf(args)}`);
    return 0;
  }

  const result = write(opts, w.snippet, { localMcp: w.localMcp, claudeHome: w.home });
  io.out(`wrote hooks + env -> ${result.settingsPath}`);
  io.out(`wrote MCP server  -> ${result.mcpTarget}: ${describeCommand(mcpEntry)}`);
  io.out(
    result.snippet === "appended"
      ? `appended snippet  -> ${result.claudeMd}`
      : `snippet already in   ${result.claudeMd}`,
  );
  if (result.excludeFile) io.out(`git-ignored local files via ${result.excludeFile}`);
  reportMigration(io, w, [dir]);
  if (result.trackedWarnings.length) {
    io.err(
      `\nWarning: these files are tracked in git, so the wiring will show up in a diff and can get committed:\n${result.trackedWarnings.map((f) => `  ${f}`).join("\n")}\nTo keep it personal instead: amc unwire ${dir} && amc wire ${dir} --local${gateFlagOf(args)}`,
    );
  }
  if (opts.gate) {
    io.out(
      `\nGate enabled for tools matching /${opts.gateMatcher}/. Each prompt waits on the board (up to ${GATE_CURL_TIMEOUT_S}s) before falling back to the terminal.`,
    );
  }
  io.out("\nRestart any running Claude Code session in that project to pick up the changes.");
  return 0;
}

export function runUnwire(args: ParsedArgs, io: Io, w: WireEnv): number {
  if (args.flags.has("--global")) {
    const { removed, backup } = unwireGlobal(w.home, {
      userMcp: w.userMcp,
      claudeJson: w.claudeJson,
    });
    if (backup) io.out(`backup: ${backup}`);
    if (removed.length === 0) io.out(`Nothing of ours found in ${w.home}.`);
    else for (const r of removed) io.out(`removed ${r}`);
    return 0;
  }
  const dir = path.resolve(w.cwd, args.positional[0] ?? ".");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    io.err(`not a directory: ${dir}`);
    return 1;
  }
  const removed = unwire(dir, { localMcp: w.localMcp, claudeHome: w.home });
  if (removed.length === 0) {
    io.out(`Nothing of ours found in ${dir}.`);
    return 0;
  }
  for (const r of removed) io.out(`removed ${r}`);
  io.out("\nRestart any running Claude Code session in that project to drop the hooks.");
  return 0;
}
