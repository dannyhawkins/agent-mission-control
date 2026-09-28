import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildHooks,
  DEFAULT_GATE_MATCHER,
  detectProjectWiring,
  isClaudeHomeProject,
  type LocalMcp,
  MCP_SERVER_NAME,
  QUESTION_GATE_MATCHER,
  reporterCommand,
  SNIPPET_START,
  type UserMcp,
  unwire,
  unwireGlobal,
  type WireOptions,
  write,
  writeGlobal,
} from "./wire";

const SNIPPET = fs.readFileSync(
  path.resolve(import.meta.dir, "../../../packages/mcp-server/CLAUDE_SNIPPET.md"),
  "utf8",
);

/** In-memory stand-in for `claude mcp add-json --scope local`, so tests never touch ~/.claude.json. */
function fakeLocalMcp() {
  const store = new Map<string, unknown>();
  const key = (dir: string, name: string) => `${fs.realpathSync(dir)}::${name}`;
  const mcp: LocalMcp = {
    has: (dir, name) => store.has(key(dir, name)),
    add: (dir, name, entry) => void store.set(key(dir, name), entry),
    remove: (dir, name) => void store.delete(key(dir, name)),
  };
  return { mcp, store };
}

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "amc-wire-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const opts = (dir: string, extra: Partial<WireOptions> = {}): WireOptions => ({
  dir,
  hubUrl: "http://127.0.0.1:4242",
  gate: true,
  gateMatcher: "Bash",
  mcp: { command: "/opt/amc/bin/amc", args: ["mcp"] },
  local: false,
  ...extra,
});

/**
 * Every file under dir (relative path -> content). Of .git only info/exclude is
 * read when asked: the rest is git's own and can change under us (maintenance).
 */
function snapshot(dir: string, withGit = false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full);
      if (e.isDirectory()) {
        if (e.name === ".git") {
          const excl = path.join(full, "info", "exclude");
          if (withGit && fs.existsSync(excl))
            out[".git/info/exclude"] = fs.readFileSync(excl, "utf8");
          continue;
        }
        walk(full);
      } else out[rel] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

const sh = (dir: string, ...args: string[]) => {
  const r = Bun.spawnSync(args, { cwd: dir, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};

describe("hook commands", () => {
  test("only SessionStart sends the parent pid; crew events are reported", () => {
    expect(reporterCommand("http://h", "SessionStart")).toContain("X-Claude-Ppid");
    expect(reporterCommand("http://h", "PreToolUse")).not.toContain("X-Claude-Ppid");
    // The messaging token rides only on SessionStart and Stop.
    expect(reporterCommand("http://h", "SessionStart")).toContain(
      "X-Claude-Token: $CLAUDE_CODE_MESSAGING_TOKEN",
    );
    expect(reporterCommand("http://h", "PreToolUse")).not.toContain("X-Claude-Token");
    const hooks = buildHooks({ hubUrl: "http://h", gate: false, gateMatcher: "" });
    for (const e of [
      "SubagentStart",
      "SubagentStop",
      "TeammateIdle",
      "TaskCreated",
      "TaskCompleted",
    ]) {
      expect(hooks[e]).toHaveLength(1);
    }
  });
});

describe("write + unwire round trip", () => {
  test("restores pre-existing files byte-for-byte and deletes the ones it created", () => {
    const dir = tempDir();
    const { mcp } = fakeLocalMcp();
    fs.writeFileSync(
      path.join(dir, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { other: { command: "other-server", args: [] } } }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Project\n\nSome rules.\n");
    fs.mkdirSync(path.join(dir, ".claude"));
    fs.writeFileSync(
      path.join(dir, ".claude", "settings.json"),
      `${JSON.stringify(
        {
          permissions: { allow: ["Bash(ls)"] },
          hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
          env: { FOO: "bar" },
        },
        null,
        2,
      )}\n`,
    );
    const before = snapshot(dir);

    write(opts(dir), SNIPPET, { localMcp: mcp });
    write(opts(dir), SNIPPET, { localMcp: mcp }); // idempotent
    const wired = snapshot(dir);
    expect(wired["CLAUDE.md"]?.split(SNIPPET_START)).toHaveLength(2);
    const mcpJson = JSON.parse(wired[".mcp.json"] ?? "{}");
    expect(Object.keys(mcpJson.mcpServers)).toEqual(["other", MCP_SERVER_NAME]);
    const settings = JSON.parse(wired[".claude/settings.json"] ?? "{}");
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.env).toEqual({ FOO: "bar", CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0" });

    const removed = unwire(dir, { localMcp: mcp });
    expect(removed.length).toBeGreaterThan(0);
    expect(snapshot(dir)).toEqual(before);
    expect(unwire(dir, { localMcp: mcp })).toEqual([]);
  });

  test("into an empty directory, unwire leaves it empty", () => {
    const dir = tempDir();
    const { mcp } = fakeLocalMcp();
    write(opts(dir), SNIPPET, { localMcp: mcp });
    expect(Object.keys(snapshot(dir)).sort()).toEqual([
      ".claude/settings.json",
      ".mcp.json",
      "CLAUDE.md",
    ]);
    unwire(dir, { localMcp: mcp });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("recognises the older unmarked snippet", () => {
    const dir = tempDir();
    const snippet = SNIPPET;
    const original = "# Project\n\nRules.\n";
    fs.writeFileSync(
      path.join(dir, "CLAUDE.md"),
      `${original}\n${snippet}\n## Later section\n\nKeep me.\n`,
    );
    unwire(dir, { localMcp: fakeLocalMcp().mcp });
    expect(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8")).toBe(
      `${original}\n## Later section\n\nKeep me.\n`,
    );
  });
});

describe("--local", () => {
  test("writes nothing git tracks and unwire restores the repo exactly", () => {
    const dir = tempDir();
    const { mcp, store } = fakeLocalMcp();
    sh(dir, "git", "init", "-q");
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Team rules\n");
    fs.writeFileSync(path.join(dir, ".mcp.json"), '{\n  "mcpServers": {}\n}\n');
    sh(dir, "git", "add", ".");
    sh(
      dir,
      "git",
      ...["-c", "user.email=t@t", "-c", "user.name=t", "-c", "maintenance.auto=false"],
      ...["-c", "gc.auto=0", "commit", "-qm", "init"],
    );
    const before = snapshot(dir, true);

    const res = write(opts(dir, { local: true }), SNIPPET, { localMcp: mcp });
    expect(res.trackedWarnings).toEqual([]);
    expect(sh(dir, "git", "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(dir, "CLAUDE.local.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".claude", "settings.local.json"))).toBe(true);
    expect([...store.values()][0]).toMatchObject({
      command: "/opt/amc/bin/amc",
      timeout: 86_400_000,
    });

    unwire(dir, { localMcp: mcp });
    expect(store.size).toBe(0);
    expect(snapshot(dir, true)).toEqual(before);
  });

  test("shared mode warns about tracked files", () => {
    const dir = tempDir();
    sh(dir, "git", "init", "-q");
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Team rules\n");
    sh(dir, "git", "add", ".");
    const res = write(opts(dir), SNIPPET, { localMcp: fakeLocalMcp().mcp });
    expect(res.trackedWarnings).toEqual([path.join(dir, "CLAUDE.md")]);
  });
});

describe("gate matchers", () => {
  test("default gate includes the question tools; questions-only is just those", () => {
    const full = buildHooks({ hubUrl: "http://h", gate: true, gateMatcher: DEFAULT_GATE_MATCHER });
    expect(full.PermissionRequest?.[1]?.matcher).toContain("AskUserQuestion|ExitPlanMode");
    expect(full.PermissionRequest?.[1]?.matcher).toContain("Bash");
    const q = buildHooks({ hubUrl: "http://h", gate: true, gateMatcher: QUESTION_GATE_MATCHER });
    expect(q.PermissionRequest?.[1]?.matcher).toBe("AskUserQuestion|ExitPlanMode");
  });
});

describe("--global", () => {
  function fakeUserMcp() {
    const store = new Map<string, unknown>();
    const mcp: UserMcp = {
      has: (name) => store.has(name),
      add: (name, entry) => void store.set(name, entry),
      remove: (name) => void store.delete(name),
    };
    return { mcp, store };
  }
  const gopts = {
    hubUrl: "http://127.0.0.1:4242",
    gate: true,
    gateMatcher: QUESTION_GATE_MATCHER,
    mcp: { command: "/opt/amc/bin/amc", args: ["mcp"] },
  };

  test("backs up, merges into settings.json, user-scope MCP, no CLAUDE.md unless asked; unwire restores", () => {
    const home = tempDir();
    const { mcp, store } = fakeUserMcp();
    const original = `${JSON.stringify(
      {
        model: "opus",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
        env: { FOO: "bar" },
      },
      null,
      2,
    )}\n`;
    fs.writeFileSync(path.join(home, "settings.json"), original);
    const deps = { userMcp: mcp, claudeJson: path.join(home, ".claude.json") };
    const now = new Date(2026, 8, 23, 9, 5, 7);

    const r = writeGlobal(gopts, home, undefined, deps, now);
    expect(r.backup).toBe(path.join(home, "settings.json.amc-backup-20260923-090507"));
    expect(fs.readFileSync(r.backup as string, "utf8")).toBe(original);
    const settings = JSON.parse(fs.readFileSync(r.settingsPath, "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.PermissionRequest[1].matcher).toBe("AskUserQuestion|ExitPlanMode");
    expect(store.get(MCP_SERVER_NAME)).toMatchObject({ timeout: 86_400_000 });
    expect(fs.existsSync(path.join(home, "CLAUDE.md"))).toBe(false);

    const later = new Date(2026, 8, 23, 10, 0, 0);
    const u = unwireGlobal(home, deps, later);
    expect(u.backup).toBe(path.join(home, "settings.json.amc-backup-20260923-100000"));
    expect(fs.readFileSync(path.join(home, "settings.json"), "utf8")).toBe(original);
    expect(store.size).toBe(0);
    expect(unwireGlobal(home, deps, later).removed).toEqual([]);
  });

  test("--snippet appends to CLAUDE.md in the Claude home, and unwire takes it out", () => {
    const home = tempDir();
    const { mcp } = fakeUserMcp();
    const deps = { userMcp: mcp, claudeJson: path.join(home, ".claude.json") };
    fs.writeFileSync(path.join(home, "CLAUDE.md"), "# Me\n\nMy rules.\n");
    const r = writeGlobal(gopts, home, SNIPPET, deps);
    expect(r.snippet).toBe("appended");
    expect(r.backup).toBeUndefined();
    unwireGlobal(home, deps);
    expect(fs.readFileSync(path.join(home, "CLAUDE.md"), "utf8")).toBe("# Me\n\nMy rules.\n");
  });

  test("detects projects that are also wired", () => {
    const home = tempDir();
    const wiredLocal = tempDir();
    const wiredShared = tempDir();
    const clean = tempDir();
    fs.writeFileSync(path.join(wiredShared, ".mcp.json"), '{"mcpServers":{"mission-control":{}}}');
    fs.mkdirSync(path.join(wiredShared, ".claude"));
    fs.writeFileSync(
      path.join(wiredShared, ".claude", "settings.json"),
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"curl http://127.0.0.1:4242/api/hooks/Stop"}]}]}}',
    );
    const claudeJson = path.join(home, ".claude.json");
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({
        projects: {
          [wiredLocal]: { mcpServers: { "mission-control": {} } },
          [wiredShared]: {},
          [clean]: { mcpServers: { other: {} } },
        },
      }),
    );
    expect(detectProjectWiring(claudeJson, home)).toEqual([
      { dir: wiredLocal, where: ["local-scope MCP server"] },
      { dir: wiredShared, where: [".mcp.json", ".claude/settings.json"] },
    ]);
  });
});

describe("the Claude config dir is never a project", () => {
  test("detectProjectWiring skips $HOME (whose .claude is the config dir)", () => {
    const userHome = tempDir();
    const configDir = path.join(userHome, ".claude");
    fs.mkdirSync(configDir);
    fs.writeFileSync(
      path.join(configDir, "settings.json"),
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"curl http://127.0.0.1:4242/api/hooks/Stop"}]}]}}',
    );
    const claudeJson = path.join(userHome, ".claude.json");
    fs.writeFileSync(claudeJson, JSON.stringify({ projects: { [userHome]: {} } }));
    expect(isClaudeHomeProject(userHome, configDir)).toBe(true);
    expect(detectProjectWiring(claudeJson, configDir)).toEqual([]);
  });

  test("per-project unwire refuses $HOME and leaves the global wiring alone", () => {
    const userHome = tempDir();
    const configDir = path.join(userHome, ".claude");
    fs.mkdirSync(configDir);
    const settings = path.join(configDir, "settings.json");
    const content =
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"curl http://127.0.0.1:4242/api/hooks/Stop"}]}]}}';
    fs.writeFileSync(settings, content);
    expect(() => unwire(userHome, { localMcp: fakeLocalMcp().mcp, claudeHome: configDir })).toThrow(
      /amc unwire --global/,
    );
    expect(fs.readFileSync(settings, "utf8")).toBe(content);
  });
});

describe("Stop hook", () => {
  test("posts to /api/hooks/stop and leaves stdout for Claude Code to read", () => {
    const hooks = buildHooks({ hubUrl: "http://h", gate: false, gateMatcher: "" });
    const cmd = hooks.Stop?.[0]?.hooks[0]?.command ?? "";
    expect(cmd).toContain("http://h/api/hooks/stop");
    expect(cmd).toContain("-sSf -m 3");
    expect(cmd).not.toContain(">/dev/null 2>&1");
    expect(cmd.endsWith("2>/dev/null || true")).toBe(true);
    expect(hooks.Stop).toHaveLength(1);
  });
});

describe("--telemetry", () => {
  const OURS = {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4242",
    OTEL_METRIC_EXPORT_INTERVAL: "10000",
    OTEL_LOGS_EXPORT_INTERVAL: "2000",
  };

  test("adds the export env (no prompt or tool-detail logging); unwire removes exactly those", () => {
    const dir = tempDir();
    const home = tempDir();
    fs.mkdirSync(path.join(dir, ".claude"));
    const settings = path.join(dir, ".claude", "settings.json");
    const original = `${JSON.stringify({ env: { FOO: "bar", OTEL_METRIC_EXPORT_INTERVAL: "30000" } }, null, 2)}\n`;
    fs.writeFileSync(settings, original);
    const { mcp } = fakeLocalMcp();
    write(opts(dir, { telemetry: true }), SNIPPET, { localMcp: mcp, claudeHome: home });
    const env = JSON.parse(fs.readFileSync(settings, "utf8")).env;
    expect(env).toMatchObject({ ...OURS, FOO: "bar", OTEL_METRIC_EXPORT_INTERVAL: "30000" });
    expect(env.OTEL_LOG_USER_PROMPTS).toBeUndefined();
    expect(env.OTEL_LOG_TOOL_DETAILS).toBeUndefined();

    unwire(dir, { localMcp: mcp, claudeHome: home });
    expect(fs.readFileSync(settings, "utf8")).toBe(original);
  });

  test("refuses when telemetry already goes to another collector, here or in user settings", () => {
    const dir = tempDir();
    const home = tempDir();
    const { mcp } = fakeLocalMcp();
    fs.writeFileSync(
      path.join(home, "settings.json"),
      JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com" } }),
    );
    expect(() =>
      write(opts(dir, { telemetry: true }), SNIPPET, { localMcp: mcp, claudeHome: home }),
    ).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT=https:\/\/otel.example.com/);
    expect(fs.existsSync(path.join(dir, ".claude", "settings.json"))).toBe(false);

    const home2 = tempDir();
    fs.writeFileSync(
      path.join(home2, "settings.json"),
      JSON.stringify({ env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://x" } }),
    );
    expect(() =>
      writeGlobal({ ...opts(home2), telemetry: true }, home2, undefined, {
        userMcp: { has: () => false, add() {}, remove() {} },
        claudeJson: path.join(home2, ".claude.json"),
      }),
    ).toThrow(/Refusing --telemetry/);
  });

  test("a user's own otlp setup (not the hub) survives unwire", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, ".claude"));
    const settings = path.join(dir, ".claude", "settings.json");
    const theirs = `${JSON.stringify(
      { env: { ...OURS, OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com" } },
      null,
      2,
    )}\n`;
    fs.writeFileSync(settings, theirs);
    unwire(dir, { localMcp: fakeLocalMcp().mcp, claudeHome: tempDir() });
    expect(fs.readFileSync(settings, "utf8")).toBe(theirs);
  });

  test("--global --telemetry round trip", () => {
    const home = tempDir();
    const store = new Map<string, unknown>();
    const deps = {
      userMcp: {
        has: (n: string) => store.has(n),
        add: (n: string, e: unknown) => void store.set(n, e),
        remove: (n: string) => void store.delete(n),
      },
      claudeJson: path.join(home, ".claude.json"),
    };
    const original = `${JSON.stringify({ model: "opus" }, null, 2)}\n`;
    fs.writeFileSync(path.join(home, "settings.json"), original);
    writeGlobal({ ...opts(home), telemetry: true }, home, undefined, deps);
    expect(JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8")).env).toMatchObject(
      OURS,
    );
    unwireGlobal(home, deps);
    expect(fs.readFileSync(path.join(home, "settings.json"), "utf8")).toBe(original);
  });
});
