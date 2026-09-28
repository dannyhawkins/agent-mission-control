import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../hub/src/config";
import { createHub, startServer } from "../../hub/src/hub";
import { VERSION } from "../../hub/src/version";
import { AMC, captureIo, cleanup, fakeClaudeJson, LEGACY, tempDir } from "../test/helpers";
import { type Check, type DoctorEnv, doctor, printChecks } from "./doctor";
import { buildHooks, DEFAULT_GATE_MATCHER, writeGlobal } from "./wire";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  cleanup();
});

/** A real hub on a free port with its own data dir; its ElevenLabs upstream is a dead port. */
function testHub(env: Record<string, string> = {}) {
  const dataDir = tempDir("amc-doctor-data-");
  const hub = createHub(
    loadConfig({
      AMC_LOG: "quiet",
      AMC_DATA_DIR: dataDir,
      AMC_CLAUDE_HOME: path.join(dataDir, "claude-home"),
      AMC_ELEVENLABS_URL: "http://127.0.0.1:9",
      AMC_TTS_PREWARM: "off",
      ...env,
    }),
  );
  const server = startServer(hub, { port: 0, host: "127.0.0.1" });
  stops.push(() => {
    server.stop(true);
    hub.stop();
  });
  return { url: `http://127.0.0.1:${server.port}`, dataDir };
}

function setup(hubUrl: string, extra: Partial<DoctorEnv> = {}) {
  const home = tempDir("amc-doctor-home-");
  const claudeJson = path.join(home, ".claude.json");
  const fake = fakeClaudeJson(claudeJson);
  const d: DoctorEnv = {
    version: VERSION,
    self: AMC,
    selfLabel: "/opt/amc/bin/amc",
    hubUrl,
    home,
    claudeJson,
    dir: tempDir("amc-doctor-proj-"),
    env: { AMC_DATA_DIR: tempDir("amc-doctor-shell-data-") },
    claudeVersion: () => "2.1.282 (Claude Code)",
    ...extra,
  };
  return { d, fake };
}

const texts = (checks: Check[], level?: Check["level"]) =>
  checks.filter((c) => !level || c.level === level).map((c) => c.text);

describe("amc doctor", () => {
  test("healthy global install: hub, version, wiring pointing at this amc, stale repo paths flagged", async () => {
    const hub = testHub();
    const { d, fake } = setup(hub.url);
    const port = new URL(hub.url).port;
    writeGlobal(
      {
        hubUrl: hub.url,
        gate: true,
        gateMatcher: DEFAULT_GATE_MATCHER,
        mcp: AMC,
        telemetry: true,
      },
      d.home,
      undefined,
      { userMcp: fake.user, claudeJson: d.claudeJson },
    );
    const stale = tempDir("amc-stale-");
    fs.writeFileSync(
      path.join(stale, ".mcp.json"),
      JSON.stringify({ mcpServers: { "mission-control": LEGACY } }),
    );
    const j = fake.read();
    j.projects = { [stale]: { mcpServers: { "mission-control": LEGACY } } };
    fake.save(j);

    const checks = await doctor(d);
    const ok = texts(checks, "ok");
    expect(ok).toContain(`hub reachable at ${hub.url}, version ${VERSION}`);
    expect(ok).toContain("Claude Code 2.1.282 (Claude Code)");
    expect(ok).toContain("MCP server, user scope: points at this amc");
    expect(ok.some((t) => t.startsWith(`hooks, ${path.join(d.home, "settings.json")}`))).toBe(true);
    expect(ok.some((t) => t.includes("telemetry") && t.includes("exported to the hub"))).toBe(true);
    expect(ok.some((t) => t.startsWith("CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0"))).toBe(true);
    expect(texts(checks, "info")).toContain(
      `permission gate, ${path.join(d.home, "settings.json")}: on (/${DEFAULT_GATE_MATCHER}/)`,
    );
    const warn = texts(checks, "warn");
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain("stale repo-path MCP wiring in 2 other place(s)");
    expect(warn[0]).toContain(path.join(stale, ".mcp.json"));
    expect(texts(checks, "fail")).toEqual([]);
    expect(texts(checks).some((t) => t.includes(`port ${port}`))).toBe(false);

    const c = captureIo();
    expect(printChecks(checks, c.io)).toBe(0);
    expect(c.text()).toContain("[ ok ] hub reachable");
    expect(c.text()).toContain("0 failed, 1 warning(s)");
  });

  test("nothing running, nothing wired: fails with the fix in the message", async () => {
    const { d } = setup("http://127.0.0.1:9", { claudeVersion: () => undefined });
    const checks = await doctor(d);
    const fail = texts(checks, "fail");
    expect(fail).toContain("hub not reachable at http://127.0.0.1:9; start it with `amc start`");
    expect(fail.some((t) => t.includes("amc wire --global --gate"))).toBe(true);
    expect(texts(checks, "warn")).toContain(
      "Claude Code: `claude --version` failed (not on PATH?)",
    );
    const c = captureIo();
    expect(printChecks(checks, c.io)).toBe(1);
    expect(c.text()).toContain("[FAIL]");
  });

  test("hub on another version, hooks on another port, stale and missing MCP entries", async () => {
    const fakeFetch = (async () =>
      Response.json({ ok: true, version: "0.0.9" })) as unknown as typeof fetch;
    const { d, fake } = setup("http://127.0.0.1:4300", { fetch: fakeFetch });
    fs.writeFileSync(
      path.join(d.home, "settings.json"),
      JSON.stringify({
        hooks: buildHooks({ hubUrl: "http://127.0.0.1:4242", gate: false, gateMatcher: "" }),
      }),
    );
    fake.save({ mcpServers: { "mission-control": LEGACY } });
    fs.mkdirSync(path.join(d.dir, ".claude"));
    fs.writeFileSync(
      path.join(d.dir, ".claude", "settings.local.json"),
      JSON.stringify({
        hooks: buildHooks({ hubUrl: "http://127.0.0.1:4300", gate: false, gateMatcher: "" }),
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" },
      }),
    );
    fs.writeFileSync(
      path.join(d.dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { "mission-control": { command: "/gone/amc", args: ["mcp"] } },
      }),
    );
    const j = fake.read();
    j.projects = { [d.dir]: { mcpServers: { "mission-control": { ...AMC } } } };
    fake.save(j);

    const checks = await doctor(d);
    const warn = texts(checks, "warn");
    expect(warn.some((t) => t.includes("runs version 0.0.9"))).toBe(true);
    expect(warn.some((t) => t.includes("aimed at port 4242 but the hub is on 4300"))).toBe(true);
    expect(warn.some((t) => t.includes("user scope: points at a repo checkout"))).toBe(true);
    expect(warn.some((t) => t.includes("AUTO_BACKGROUND_MS is not 0"))).toBe(true);
    // Right command but no 24h timeout.
    expect(warn.some((t) => t.includes("local scope") && t.includes("no 24h timeout"))).toBe(true);
    expect(texts(checks, "fail").some((t) => t.includes("missing binary (/gone/amc mcp)"))).toBe(
      true,
    );
    expect(texts(checks, "info").some((t) => t.includes("exported to http://collector:4318"))).toBe(
      true,
    );
    expect(texts(checks, "info")).toContain(
      `permission gate, ${path.join(d.dir, ".claude", "settings.local.json")}: off`,
    );
  });

  test("run from the home dir, ~/.claude/settings.json is not checked twice", async () => {
    const hub = testHub();
    const { d, fake } = setup(hub.url);
    // Home layout: <userHome>/.claude is the config dir.
    const userHome = tempDir("amc-userhome-");
    const configDir = path.join(userHome, ".claude");
    fs.mkdirSync(configDir);
    writeGlobal(
      { hubUrl: hub.url, gate: true, gateMatcher: DEFAULT_GATE_MATCHER, mcp: AMC },
      configDir,
      undefined,
      { userMcp: fake.user, claudeJson: d.claudeJson },
    );
    const checks = await doctor({ ...d, home: configDir, dir: userHome });
    const hookLines = texts(checks).filter((t) => t.startsWith("hooks, "));
    expect(hookLines).toHaveLength(1);
    expect(texts(checks).filter((t) => t.startsWith("permission gate"))).toHaveLength(1);
    expect(texts(checks).filter((t) => t.includes("AUTO_BACKGROUND_MS"))).toHaveLength(1);
  });

  test("other MCP command is a warning; a global entry without hooks says so", async () => {
    const { d, fake } = setup("http://127.0.0.1:9");
    fake.save({ mcpServers: { "mission-control": { command: "npx", args: ["x"] } } });
    const checks = await doctor(d);
    const warn = texts(checks, "warn");
    expect(warn.some((t) => t.includes("points at npx x, not this amc"))).toBe(true);
    expect(warn.some((t) => t.includes("none (amc wire --global)"))).toBe(true);
  });
});

describe("amc doctor: ElevenLabs", () => {
  const KEY = "sk_test_do_not_print_me";

  test("asks the running hub, which uses secrets.env even when this shell has a key", async () => {
    const hub = testHub();
    const secrets = path.join(hub.dataDir, "secrets.env");
    fs.writeFileSync(secrets, `ELEVENLABS_API_KEY=${KEY}\n`, { mode: 0o600 });
    const { d } = setup(hub.url);
    const checks = await doctor({
      ...d,
      env: { AMC_DATA_DIR: hub.dataDir, ELEVENLABS_API_KEY: "sk_shell_key" },
    });
    const all = texts(checks).join("\n");
    expect(all).toContain(`ElevenLabs voice (running hub): configured (key from ${secrets})`);
    expect(all).toContain(
      "a shell-exported key overrides secrets.env for hubs started from this shell",
    );
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("sk_shell_key");
  });

  test("hub with its key in its own environment, and a hub with none", async () => {
    const withEnv = testHub({ ELEVENLABS_API_KEY: KEY });
    const a = await doctor(setup(withEnv.url).d);
    expect(texts(a)).toContain(
      "ElevenLabs voice (running hub): configured (key from the hub's environment)",
    );
    expect(texts(a).join("\n")).not.toContain(KEY);

    const none = testHub();
    const b = await doctor(setup(none.url).d);
    expect(texts(b)).toContain(
      "ElevenLabs voice (running hub): not configured, browser voice only",
    );
  });

  test("no hub: this shell's view, plus file permission problems", async () => {
    const { d } = setup("http://127.0.0.1:9");
    const dataDir = d.env.AMC_DATA_DIR as string;
    expect(texts(await doctor(d))).toContain(
      "ElevenLabs voice (hub not running, from this shell): not configured",
    );
    expect(texts(await doctor({ ...d, env: { ...d.env, ELEVENLABS_API_KEY: KEY } }))).toContain(
      "ElevenLabs voice (hub not running, from this shell): configured (ELEVENLABS_API_KEY in this shell)",
    );

    const secrets = path.join(dataDir, "secrets.env");
    fs.writeFileSync(secrets, `ELEVENLABS_API_KEY=${KEY}\n`, { mode: 0o600 });
    expect(texts(await doctor(d))).toContain(
      `ElevenLabs voice (hub not running, from this shell): configured (${secrets})`,
    );
    fs.chmodSync(secrets, 0o644);
    const open = texts(await doctor(d), "warn");
    expect(open.some((t) => t.includes("readable by others") && t.includes("chmod 600"))).toBe(
      true,
    );
  });
});
