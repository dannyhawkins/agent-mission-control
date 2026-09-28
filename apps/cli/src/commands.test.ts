import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { AMC, captureIo, cleanup, fakeClaudeJson, LEGACY, tempDir } from "../test/helpers";
import { parseArgs } from "./args";
import { hubUrlFor, isMissionControlRepo, runUnwire, runWire, type WireEnv } from "./commands";

afterEach(cleanup);

const SNIPPET = "## Decisions go through Mission Control\n\nUse request_decision.";

function env(): WireEnv & { fake: ReturnType<typeof fakeClaudeJson> } {
  const home = tempDir("amc-home-");
  const claudeJson = path.join(home, ".claude.json");
  const fake = fakeClaudeJson(claudeJson);
  return {
    home,
    claudeJson,
    userMcp: fake.user,
    localMcp: fake.local,
    mcp: AMC,
    snippet: SNIPPET,
    cwd: tempDir("amc-cwd-"),
    fake,
  };
}

const run = (argv: string[], w: WireEnv, e: NodeJS.ProcessEnv = {}) => {
  const c = captureIo();
  const args = parseArgs(argv);
  const code = args.command === "wire" ? runWire(args, c.io, w, e) : runUnwire(args, c.io, w);
  return { code, ...c };
};

describe("amc wire --global", () => {
  test("migrates repo-path wiring on a temp HOME and says what changed; second run is a no-op", () => {
    const w = env();
    const proj = tempDir("amc-proj-");
    fs.writeFileSync(
      path.join(proj, ".mcp.json"),
      JSON.stringify({ mcpServers: { "mission-control": LEGACY } }),
    );
    w.fake.save({
      mcpServers: { "mission-control": LEGACY },
      projects: { [proj]: { mcpServers: { "mission-control": LEGACY } } },
    });

    const r = run(["wire", "--global", "--gate", "--telemetry"], w);
    expect(r.code).toBe(0);
    expect(r.text()).toContain(
      `wrote MCP server  -> user scope (${w.claudeJson}): /opt/amc/bin/amc mcp`,
    );
    expect(r.text()).toContain("Migrated MCP wiring that pointed at a repo checkout:");
    expect(r.text()).toContain(`local scope, project ${proj}`);
    expect(r.text()).toContain(path.join(proj, ".mcp.json"));
    expect(r.text()).toContain("Gate enabled");
    // Projects still wired per project get the duplicate warning.
    expect(r.errText()).toContain(`amc unwire ${proj}`);

    const j = w.fake.read();
    expect(j.mcpServers?.["mission-control"]).toMatchObject({ ...AMC, timeout: 86_400_000 });
    expect(j.projects?.[proj]?.mcpServers?.["mission-control"]).toMatchObject(AMC);
    const settings = JSON.parse(fs.readFileSync(path.join(w.home, "settings.json"), "utf8"));
    expect(settings.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://127.0.0.1:4242");
    expect(JSON.stringify(settings.hooks.PermissionRequest)).toContain("/api/hooks/gate");

    const again = run(["wire", "--global", "--gate", "--telemetry"], w);
    expect(again.code).toBe(0);
    expect(again.text()).not.toContain("Migrated");
  });

  test("--snippet appends to the home CLAUDE.md; --dry-run writes nothing", () => {
    const w = env();
    const dry = run(["wire", "--global", "--dry-run", "--gate-questions-only"], w);
    expect(dry.code).toBe(0);
    expect(dry.text()).toContain("claude mcp add-json --scope user mission-control");
    expect(dry.text()).toContain('"command":"/opt/amc/bin/amc"');
    expect(dry.text()).toContain("amc wire --global --gate-questions-only");
    expect(fs.existsSync(path.join(w.home, "settings.json"))).toBe(false);

    const r = run(["wire", "--global", "--snippet", "--port", "4300"], w);
    expect(r.text()).toContain(`appended snippet  -> ${path.join(w.home, "CLAUDE.md")}`);
    expect(fs.readFileSync(path.join(w.home, "settings.json"), "utf8")).toContain(
      "127.0.0.1:4300/api/hooks/",
    );
    expect(run(["wire", "--global", "--snippet"], w).text()).toContain("snippet already in");
  });

  test("unwire --global removes it again", () => {
    const w = env();
    run(["wire", "--global"], w);
    const r = run(["unwire", "--global"], w);
    expect(r.code).toBe(0);
    expect(r.text()).toContain('removed MCP server "mission-control" from user scope');
    expect(w.fake.read().mcpServers?.["mission-control"]).toBeUndefined();
    expect(run(["unwire", "--global"], w).text()).toContain("Nothing of ours found");
  });
});

describe("amc wire <dir>", () => {
  test("wires a project to the binary, migrating a stale user-scope entry too", () => {
    const w = env();
    w.fake.save({ mcpServers: { "mission-control": LEGACY } });
    const proj = tempDir("amc-proj-");
    const r = run(["wire", proj, "--gate"], w);
    expect(r.code).toBe(0);
    expect(r.text()).toContain(`wrote MCP server  -> ${path.join(proj, ".mcp.json")}`);
    expect(r.text()).toContain("appended snippet");
    expect(r.text()).toContain("user scope");
    const mcp = JSON.parse(fs.readFileSync(path.join(proj, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers["mission-control"]).toMatchObject({ ...AMC, timeout: 86_400_000 });
    expect(w.fake.read().mcpServers?.["mission-control"]).toMatchObject(AMC);
    expect(fs.readFileSync(path.join(proj, "CLAUDE.md"), "utf8")).toContain("request_decision");
  });

  test("a relative dir resolves against cwd; --local uses local scope", () => {
    const w = env();
    fs.mkdirSync(path.join(w.cwd, "sub"));
    const r = run(["wire", "sub", "--local"], w);
    expect(r.code).toBe(0);
    const sub = path.join(w.cwd, "sub");
    expect(w.fake.read().projects?.[sub]?.mcpServers?.["mission-control"]).toMatchObject(AMC);
    expect(fs.existsSync(path.join(sub, "CLAUDE.local.md"))).toBe(true);

    const u = run(["unwire", "sub"], w);
    expect(u.code).toBe(0);
    expect(u.text()).toContain("from local scope");
    expect(run(["unwire", "sub"], w).text()).toContain("Nothing of ours found");
  });

  test("--dry-run prints hooks, .mcp.json or the local-scope command, and the snippet", () => {
    const w = env();
    const shared = run(["wire", ".", "--dry-run", "--gate"], w);
    expect(shared.text()).toContain('"mcpServers"');
    expect(shared.text()).toContain("<!-- mission-control:start -->");
    expect(shared.text()).toContain(`amc wire ${w.cwd} --gate`);
    const local = run(["wire", ".", "--dry-run", "--local"], w);
    expect(local.text()).toContain("claude mcp add-json --scope local mission-control");
    expect(fs.readdirSync(w.cwd)).toEqual([]);
  });

  test("refuses a missing dir and the mission control repo itself (unless --force)", () => {
    const w = env();
    expect(run(["wire", "nope"], w).code).toBe(1);
    expect(run(["unwire", "nope"], w).code).toBe(1);
    const repo = path.resolve(import.meta.dir, "../../..");
    expect(isMissionControlRepo(repo)).toBe(true);
    const r = run(["wire", repo], w);
    expect(r.code).toBe(1);
    expect(r.errText()).toContain("Refusing to wire the mission control repo");
  });

  test("hub URL: --port, then AMC_PORT, then 4242", () => {
    expect(hubUrlFor(parseArgs(["wire", "--port", "5000"]), { AMC_PORT: "6000" })).toBe(
      "http://127.0.0.1:5000",
    );
    expect(hubUrlFor(parseArgs(["wire"]), { AMC_PORT: "6000" })).toBe("http://127.0.0.1:6000");
    expect(hubUrlFor(parseArgs(["wire"]), {})).toBe("http://127.0.0.1:4242");
  });
});
