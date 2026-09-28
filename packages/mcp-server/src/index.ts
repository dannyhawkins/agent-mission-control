#!/usr/bin/env bun
/**
 * stdio entry for the mission control MCP server (server.ts has the tools).
 * Claude Code launches it as `amc mcp`; `bun packages/mcp-server/src/index.ts`
 * still works for poking at it with an MCP inspector (task mcp).
 */
import { DEFAULT_HUB_URL } from "@amc/shared";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpClient, createServer } from "./server";

/**
 * This process is a descendant of `claude`, whose pid hooks report as
 * X-Claude-Pid. Wrappers (bunx, npx, sh) can sit in between, so walk a few levels.
 */
export function collectAncestorPids(start = process.ppid, depth = 6): number[] {
  const pids: number[] = [];
  let pid = start;
  for (let i = 0; i < depth && pid > 1; i++) {
    pids.push(pid);
    try {
      const out = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)])
        .stdout.toString()
        .trim();
      const next = Number.parseInt(out, 10);
      if (!Number.isInteger(next) || next <= 1) break;
      pid = next;
    } catch {
      break;
    }
  }
  return pids;
}

/**
 * Session identity, best first. Claude Code (2.1.280 observed) exports
 * CLAUDE_CODE_SESSION_ID and CLAUDE_PROJECT_DIR to stdio MCP servers; that is
 * undocumented, so the pid chain and cwd stay as fallbacks for the hub.
 */
export async function runStdio(version?: string): Promise<void> {
  const env = process.env;
  const client = createMcpClient({
    hubUrl: env.AMC_HUB_URL ?? DEFAULT_HUB_URL,
    sessionId: env.CLAUDE_CODE_SESSION_ID || undefined,
    cwd: env.CLAUDE_PROJECT_DIR || process.cwd(),
    ancestorPids: collectAncestorPids(),
  });

  const bye = () => void client.cancelAll().finally(() => process.exit(0));
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, bye);
  process.stdin.on("end", bye);

  // Heartbeat so the hub can show the station before the first hook or decision.
  void client.reportStatus("mcp online", 2_000);

  await createServer(client, version).connect(new StdioServerTransport());
}

if (import.meta.main) await runStdio();
