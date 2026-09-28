import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { VERSION } from "../../hub/src/version";
import { AMC, captureIo, cleanup, fakeClaudeJson, tempDir } from "../test/helpers";
import type { ParsedArgs } from "./args";
import { type MainDeps, main, realDeps } from "./main";
import { isCompiled, SNIPPET, selfDescription, selfMcpCommand, stableExecPath } from "./self";

afterEach(cleanup);

function deps(over: Partial<MainDeps> = {}) {
  const c = captureIo();
  const calls: string[] = [];
  const home = tempDir("amc-main-home-");
  const claudeJson = path.join(home, ".claude.json");
  const fake = fakeClaudeJson(claudeJson);
  const cwd = tempDir("amc-main-cwd-");
  const d: MainDeps = {
    io: c.io,
    start: (port) => void calls.push(`start ${port}`),
    mcp: async () => void calls.push("mcp"),
    wireEnv: (_args: ParsedArgs) => ({
      home,
      claudeJson,
      userMcp: fake.user,
      localMcp: fake.local,
      mcp: AMC,
      snippet: SNIPPET,
      cwd,
    }),
    env: {},
    claudeVersion: () => "2.1.282",
    ...over,
  };
  return { d, c, calls, home, cwd };
}

describe("main", () => {
  test("--version and version print the root package version", async () => {
    const { d, c } = deps();
    expect(await main(["--version"], d)).toBe(0);
    expect(await main(["version"], d)).toBe(0);
    expect(c.out).toEqual([VERSION, VERSION]);
    expect(VERSION).toMatch(/^0\.\d+\.\d+/);
  });

  test("help, per-command help, and usage errors exit 2 with the help text", async () => {
    const { d, c } = deps();
    expect(await main([], d)).toBe(0);
    expect(c.text()).toContain("Usage: amc <command>");
    expect(await main(["wire", "--help"], d)).toBe(0);
    expect(c.text()).toContain("--gate-questions-only");
    expect(await main(["help", "bogus"], d)).toBe(0);
    expect(await main(["bogus"], d)).toBe(2);
    expect(c.errText()).toContain('amc: unknown command "bogus"');
  });

  test("start and mcp hand off to the long-running roles", async () => {
    const { d, calls } = deps();
    expect(await main(["start", "--port", "4300"], d)).toBe(0);
    expect(await main(["start"], d)).toBe(0);
    expect(await main(["mcp"], d)).toBe(0);
    expect(calls).toEqual(["start 4300", "start undefined", "mcp"]);
  });

  test("a failing start (port in use) is a message and exit 1, not a stack trace", async () => {
    const { d, c } = deps({
      start: () => {
        throw new Error("Failed to start server. Is port 4242 in use?");
      },
    });
    expect(await main(["start"], d)).toBe(1);
    expect(c.errText()).toBe("Failed to start server. Is port 4242 in use?");
  });

  test("wire, unwire and doctor run against the injected environment", async () => {
    const { d, c, cwd } = deps();
    expect(await main(["wire", "."], d)).toBe(0);
    expect(c.text()).toContain(`wrote MCP server  -> ${path.join(cwd, ".mcp.json")}`);
    expect(await main(["doctor", "--port", "9"], d)).toBe(1); // no hub on :9
    expect(c.text()).toContain("[ ok ] MCP server");
    expect(await main(["unwire"], d)).toBe(0);
    expect(c.text()).toContain("removed MCP server");
  });

  test("refusals from the wiring library become exit 1", async () => {
    const { d, c, cwd } = deps();
    await Bun.write(path.join(cwd, ".claude", "settings.json"), "{ not json");
    expect(await main(["wire", "."], d)).toBe(1);
    expect(c.errText()).toContain("is not valid JSON");
  });

  test("real deps wire this checkout's source entry", () => {
    const w = realDeps.wireEnv({
      command: "wire",
      positional: [],
      flags: new Set(),
      values: { "--home": tempDir("amc-real-home-") },
    });
    expect(w.mcp.args.at(-1)).toBe("mcp");
    expect(w.snippet).toContain("request_decision");
  });
});

describe("self", () => {
  test("compiled vs checkout", () => {
    expect(isCompiled("/$bunfs/root")).toBe(true);
    expect(isCompiled("B:/~BUN/root")).toBe(true);
    expect(isCompiled()).toBe(false);
    expect(selfMcpCommand(true)).toEqual({ command: process.execPath, args: ["mcp"] });
    const src = selfMcpCommand(false);
    expect(src.command).toBe(process.execPath);
    expect(src.args).toEqual([path.join(import.meta.dir, "main.ts"), "mcp"]);
    expect(selfDescription(true)).toBe(process.execPath);
    expect(selfDescription(false)).toContain("(from source)");
  });

  test("a Homebrew keg path is recorded as the opt symlink that survives brew upgrade", () => {
    const keg = "/opt/homebrew/Cellar/amc/0.1.0/bin/amc";
    const opt = "/opt/homebrew/opt/amc/bin/amc";
    expect(stableExecPath(keg, (p) => p === opt)).toBe(opt);
    expect(stableExecPath(keg, () => false)).toBe(keg);
    expect(stableExecPath("/home/me/.local/bin/amc", () => true)).toBe("/home/me/.local/bin/amc");
  });
});
