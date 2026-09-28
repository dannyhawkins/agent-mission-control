import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalMcp, UserMcp } from "../src/wire";

const dirs: string[] = [];

export function tempDir(prefix = "amc-cli-"): string {
  // realpath: macOS tmpdir is a symlink, and .claude.json keys are real paths.
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

export function cleanup() {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

type Json = {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
};

/**
 * Stand-in for the claude CLI's user and local MCP scopes that edits a temp
 * .claude.json the same way (local scope keyed by the project's real path),
 * so tests never run `claude` or touch ~/.claude.json.
 */
export function fakeClaudeJson(file: string) {
  const read = (): Json => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Json;
    } catch {
      return {};
    }
  };
  const save = (j: Json) => fs.writeFileSync(file, JSON.stringify(j, null, 2));
  const calls: string[] = [];
  const user: UserMcp = {
    has: (name) => Boolean(read().mcpServers?.[name]),
    add(name, entry) {
      calls.push(`user add ${name}`);
      const j = read();
      j.mcpServers = { ...j.mcpServers, [name]: entry };
      save(j);
    },
    remove(name) {
      calls.push(`user remove ${name}`);
      const j = read();
      delete j.mcpServers?.[name];
      save(j);
    },
  };
  const local: LocalMcp = {
    has: (dir, name) => Boolean(read().projects?.[fs.realpathSync(dir)]?.mcpServers?.[name]),
    add(dir, name, entry) {
      calls.push(`local add ${dir} ${name}`);
      const j = read();
      const key = fs.realpathSync(dir);
      j.projects ??= {};
      j.projects[key] = {
        ...j.projects[key],
        mcpServers: { ...j.projects[key]?.mcpServers, [name]: entry },
      };
      save(j);
    },
    remove(dir, name) {
      calls.push(`local remove ${dir} ${name}`);
      const j = read();
      delete j.projects?.[fs.realpathSync(dir)]?.mcpServers?.[name];
      save(j);
    },
  };
  return { user, local, read, save, calls };
}

/** What wiring looked like before the amc binary. */
export const LEGACY = {
  type: "stdio",
  command: "bun",
  args: ["/old/checkout/packages/mcp-server/src/index.ts"],
  env: { AMC_HUB_URL: "http://127.0.0.1:4242" },
  timeout: 86_400_000,
};

export const AMC = { command: "/opt/amc/bin/amc", args: ["mcp"] };

export function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l) },
    out,
    err,
    text: () => out.join("\n"),
    errText: () => err.join("\n"),
  };
}
