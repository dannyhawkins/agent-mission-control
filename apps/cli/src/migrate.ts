/**
 * Moving existing installs onto the amc binary. Before it existed, wiring
 * pointed Claude Code at `bun <checkout>/packages/mcp-server/src/index.ts`; a
 * checkout-run `task wire` now writes `bun <checkout>/apps/cli/src/main.ts mcp`.
 * Both tie every session to a repo path, so `amc wire` rewrites them to the
 * binary wherever they live: user scope, local scope (per project in
 * .claude.json) and each known project's .mcp.json. Everything else in the
 * entry (env, extra fields) is kept; the 24h timeout is (re)applied.
 */
import fs from "node:fs";
import path from "node:path";
import {
  type LocalMcp,
  MCP_SERVER_NAME,
  MCP_TIMEOUT_MS,
  type McpCommand,
  readClaudeJson,
  readJson,
  type UserMcp,
  writeJson,
} from "./wire";

interface McpEntry {
  type?: string;
  command?: unknown;
  args?: unknown;
  [k: string]: unknown;
}

const REPO_ENTRY = /(packages\/mcp-server\/src\/index\.ts|apps\/cli\/src\/main\.ts)$/;

/** `bun <something>/packages/mcp-server/src/index.ts` or `bun <something>/apps/cli/src/main.ts mcp`. */
export function isRepoPathEntry(entry: unknown): boolean {
  const e = entry as McpEntry | undefined;
  if (!e || typeof e.command !== "string" || !Array.isArray(e.args)) return false;
  const first = e.args[0];
  return (
    /(^|[/\\])bun(\.exe)?$/.test(e.command) &&
    typeof first === "string" &&
    REPO_ENTRY.test(first.replaceAll("\\", "/"))
  );
}

export function sameCommand(entry: unknown, target: McpCommand): boolean {
  const e = entry as McpEntry | undefined;
  return (
    !!e &&
    e.command === target.command &&
    JSON.stringify(e.args ?? []) === JSON.stringify(target.args)
  );
}

export type EntryState = "current" | "repo-path" | "other" | "missing-binary";

/** How an existing mission-control entry relates to the amc that is asking. */
export function entryState(entry: unknown, target: McpCommand): EntryState {
  if (sameCommand(entry, target)) return "current";
  if (isRepoPathEntry(entry)) return "repo-path";
  const cmd = (entry as McpEntry | undefined)?.command;
  if (typeof cmd === "string" && path.isAbsolute(cmd) && !fs.existsSync(cmd)) {
    return "missing-binary";
  }
  return "other";
}

export function describeCommand(entry: unknown): string {
  const e = entry as McpEntry | undefined;
  const args = Array.isArray(e?.args) ? e.args.join(" ") : "";
  return `${String(e?.command ?? "?")}${args ? ` ${args}` : ""}`;
}

function migrated(entry: McpEntry, target: McpCommand): McpEntry {
  return {
    ...entry,
    type: entry.type ?? "stdio",
    command: target.command,
    args: target.args,
    timeout: MCP_TIMEOUT_MS,
  };
}

export interface MigrateDeps {
  userMcp: UserMcp;
  localMcp: LocalMcp;
  claudeJson: string;
  /** Extra project dirs to look at besides the ones .claude.json knows. */
  extraDirs?: string[];
}

export interface Migration {
  where: string;
  from: string;
  to: string;
}

/**
 * Rewrites every repo-path mission-control entry to `target`. Idempotent: an
 * entry already at `target` (or pointing anywhere else) is left alone.
 * Returns what changed plus what could not be changed and why.
 */
export function migrateMcpEntries(
  target: McpCommand,
  deps: MigrateDeps,
): { changed: Migration[]; skipped: string[] } {
  const changed: Migration[] = [];
  const skipped: string[] = [];
  const to = describeCommand(target);
  const shouldMove = (e: unknown) => isRepoPathEntry(e) && !sameCommand(e, target);

  const cj = readClaudeJson(deps.claudeJson);
  const user = cj.mcpServers?.[MCP_SERVER_NAME];
  if (shouldMove(user)) {
    deps.userMcp.add(MCP_SERVER_NAME, migrated(user as McpEntry, target));
    changed.push({ where: `user scope (${deps.claudeJson})`, from: describeCommand(user), to });
  }

  const dirs = new Set([...Object.keys(cj.projects ?? {}), ...(deps.extraDirs ?? [])]);
  for (const dir of dirs) {
    const local = cj.projects?.[dir]?.mcpServers?.[MCP_SERVER_NAME];
    if (shouldMove(local)) {
      // The claude CLI keys local scope by its working directory, so it has to exist.
      if (fs.existsSync(dir)) {
        try {
          deps.localMcp.add(dir, MCP_SERVER_NAME, migrated(local as McpEntry, target));
          // The claude CLI keys local scope by its own idea of the project (a
          // subdirectory of a git repo lands on the repo root), so check it took.
          const after = readClaudeJson(deps.claudeJson).projects?.[dir]?.mcpServers?.[
            MCP_SERVER_NAME
          ];
          if (isRepoPathEntry(after)) {
            skipped.push(
              `local scope, project ${dir}: the claude CLI filed the new entry under another project; run \`claude mcp remove --scope local ${MCP_SERVER_NAME}\` there and wire it again`,
            );
          } else {
            changed.push({
              where: `local scope, project ${dir}`,
              from: describeCommand(local),
              to,
            });
          }
        } catch (err) {
          // One odd project (the CLI keys it differently, say) must not stop the rest.
          skipped.push(`local scope, project ${dir}: ${(err as Error).message}`);
        }
      } else {
        skipped.push(`local scope, project ${dir}: directory no longer exists`);
      }
    }
    const mcpPath = path.join(dir, ".mcp.json");
    if (!fs.existsSync(mcpPath)) continue;
    let f: ReturnType<typeof readJson>;
    try {
      f = readJson(mcpPath);
    } catch (err) {
      skipped.push(`${mcpPath}: ${(err as Error).message}`);
      continue;
    }
    const servers = f.data.mcpServers as Record<string, McpEntry> | undefined;
    const entry = servers?.[MCP_SERVER_NAME];
    if (servers && entry && shouldMove(entry)) {
      servers[MCP_SERVER_NAME] = migrated(entry, target);
      writeJson(mcpPath, f);
      changed.push({ where: mcpPath, from: describeCommand(entry), to });
    }
  }
  return { changed, skipped };
}
