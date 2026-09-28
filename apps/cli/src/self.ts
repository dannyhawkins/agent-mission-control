import fs from "node:fs";
import path from "node:path";
import snippet from "../../../packages/mcp-server/CLAUDE_SNIPPET.md" with { type: "text" };
import { VERSION } from "../../hub/src/version";
import type { McpCommand } from "./wire";

export { VERSION };

/** The CLAUDE.md text for wired projects, inlined so the binary needs no checkout. */
export const SNIPPET: string = snippet;

/**
 * A `bun build --compile` binary runs its modules from Bun's virtual filesystem
 * (/$bunfs/root on unix, B:/~BUN/root on Windows); from a checkout this is a real path.
 */
export function isCompiled(dir = import.meta.dir): boolean {
  return dir.startsWith("/$bunfs") || dir.includes("~BUN");
}

const SOURCE_MAIN = path.resolve(import.meta.dir, "main.ts");

/**
 * The path to record for this binary. process.execPath is the resolved path, and
 * under Homebrew that is the versioned keg (<prefix>/Cellar/amc/0.1.0/bin/amc),
 * which `brew upgrade` deletes. <prefix>/opt/amc/bin/amc is Homebrew's stable
 * symlink to the current keg, so wiring made through it survives upgrades.
 */
export function stableExecPath(
  execPath = process.execPath,
  exists: (p: string) => boolean = fs.existsSync,
): string {
  const m = /^(.*)\/Cellar\/amc\/[^/]+\/bin\/amc$/.exec(execPath);
  if (!m) return execPath;
  const opt = `${m[1]}/opt/amc/bin/amc`;
  return exists(opt) ? opt : execPath;
}

/**
 * How Claude Code should launch our MCP server. From the binary: the binary
 * itself. From a checkout (task wire): bun + this checkout's main.ts, so repo
 * users need no build. Both absolute, so neither depends on Claude Code's PATH.
 */
export function selfMcpCommand(compiled = isCompiled()): McpCommand {
  return compiled
    ? { command: stableExecPath(), args: ["mcp"] }
    : { command: process.execPath, args: [SOURCE_MAIN, "mcp"] };
}

/** How to show "this amc" in messages. */
export function selfDescription(compiled = isCompiled()): string {
  return compiled ? stableExecPath() : `bun ${SOURCE_MAIN} (from source)`;
}
