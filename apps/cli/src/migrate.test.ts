import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { AMC, cleanup, fakeClaudeJson, LEGACY, tempDir } from "../test/helpers";
import {
  describeCommand,
  entryState,
  isRepoPathEntry,
  migrateMcpEntries,
  sameCommand,
} from "./migrate";

afterEach(cleanup);

describe("recognising entries", () => {
  test("repo-path: bun + the old mcp-server entry or the checkout's cli main", () => {
    expect(isRepoPathEntry(LEGACY)).toBe(true);
    expect(
      isRepoPathEntry({
        command: "/Users/x/.bun/bin/bun",
        args: ["/r/apps/cli/src/main.ts", "mcp"],
      }),
    ).toBe(true);
    expect(
      isRepoPathEntry({ command: "bun", args: ["C:\\r\\packages\\mcp-server\\src\\index.ts"] }),
    ).toBe(true);
    expect(isRepoPathEntry(AMC)).toBe(false);
    expect(
      isRepoPathEntry({ command: "node", args: ["/r/packages/mcp-server/src/index.ts"] }),
    ).toBe(false);
    expect(isRepoPathEntry({ command: "bun" })).toBe(false);
    expect(isRepoPathEntry(undefined)).toBe(false);
  });

  test("entryState", () => {
    expect(entryState({ ...AMC, env: {} }, AMC)).toBe("current");
    expect(entryState(LEGACY, AMC)).toBe("repo-path");
    expect(entryState({ command: "/nope/amc", args: ["mcp"] }, AMC)).toBe("missing-binary");
    expect(entryState({ command: "npx", args: ["something"] }, AMC)).toBe("other");
    expect(sameCommand(undefined, AMC)).toBe(false);
    expect(describeCommand(AMC)).toBe("/opt/amc/bin/amc mcp");
    expect(describeCommand({})).toBe("?");
  });
});

describe("migrateMcpEntries", () => {
  function setup() {
    const home = tempDir();
    const claudeJson = path.join(home, ".claude.json");
    const fake = fakeClaudeJson(claudeJson);
    const proj = tempDir();
    const shared = tempDir();
    const gone = path.join(home, "deleted-project");
    fake.save({
      mcpServers: { "mission-control": LEGACY, other: { command: "x" } },
      projects: {
        [proj]: { mcpServers: { "mission-control": LEGACY } },
        [shared]: {},
        [gone]: { mcpServers: { "mission-control": LEGACY } },
      },
    });
    fs.writeFileSync(
      path.join(shared, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { "mission-control": { ...LEGACY, timeout: 5 }, keep: { command: "k" } } }, null, 4)}\n`,
    );
    const deps = { userMcp: fake.user, localMcp: fake.local, claudeJson };
    return { fake, proj, shared, gone, deps, claudeJson };
  }

  test("rewrites user scope, local scope and .mcp.json to the binary; keeps env and neighbours", () => {
    const { fake, proj, shared, gone, deps } = setup();
    const r = migrateMcpEntries(AMC, deps);
    expect(r.changed.map((c) => c.where)).toEqual([
      expect.stringContaining("user scope"),
      `local scope, project ${proj}`,
      path.join(shared, ".mcp.json"),
    ]);
    expect(r.changed[0]?.from).toBe("bun /old/checkout/packages/mcp-server/src/index.ts");
    expect(r.changed[0]?.to).toBe("/opt/amc/bin/amc mcp");
    expect(r.skipped).toEqual([`local scope, project ${gone}: directory no longer exists`]);

    const j = fake.read();
    const want = { ...LEGACY, ...AMC };
    expect(j.mcpServers?.["mission-control"]).toEqual(want);
    expect(j.mcpServers?.other).toEqual({ command: "x" });
    expect(j.projects?.[proj]?.mcpServers?.["mission-control"]).toEqual(want);

    const text = fs.readFileSync(path.join(shared, ".mcp.json"), "utf8");
    expect(text.startsWith('{\n    "mcpServers"')).toBe(true); // file's own indent kept
    const mcp = JSON.parse(text);
    expect(mcp.mcpServers["mission-control"]).toEqual(want); // 24h timeout re-applied
    expect(mcp.mcpServers.keep).toEqual({ command: "k" });
  });

  test("idempotent: a second run changes nothing", () => {
    const { deps, fake } = setup();
    migrateMcpEntries(AMC, deps);
    const before = JSON.stringify(fake.read());
    const again = migrateMcpEntries(AMC, deps);
    expect(again.changed).toEqual([]);
    expect(JSON.stringify(fake.read())).toBe(before);
  });

  test("leaves entries it did not write (another binary, npx) alone", () => {
    const home = tempDir();
    const claudeJson = path.join(home, ".claude.json");
    const fake = fakeClaudeJson(claudeJson);
    const other = { command: "npx", args: ["some-mcp"] };
    fake.save({ mcpServers: { "mission-control": other } });
    const r = migrateMcpEntries(AMC, { userMcp: fake.user, localMcp: fake.local, claudeJson });
    expect(r.changed).toEqual([]);
    expect(fake.read().mcpServers?.["mission-control"]).toEqual(other);
  });

  test("extraDirs are scanned even when .claude.json does not know them; bad JSON is reported", () => {
    const home = tempDir();
    const claudeJson = path.join(home, ".claude.json");
    const fake = fakeClaudeJson(claudeJson);
    const a = tempDir();
    const b = tempDir();
    fs.writeFileSync(
      path.join(a, ".mcp.json"),
      JSON.stringify({ mcpServers: { "mission-control": LEGACY } }),
    );
    fs.writeFileSync(path.join(b, ".mcp.json"), "{ nope");
    const r = migrateMcpEntries(AMC, {
      userMcp: fake.user,
      localMcp: fake.local,
      claudeJson,
      extraDirs: [a, b],
    });
    expect(r.changed.map((c) => c.where)).toEqual([path.join(a, ".mcp.json")]);
    expect(r.skipped[0]).toContain("not valid JSON");
  });

  test("a local-scope write the CLI files elsewhere, or that fails, is reported, not claimed", () => {
    const { fake, proj, deps } = setup();
    const misfiled = {
      ...deps,
      localMcp: { ...fake.local, add: () => {} },
    };
    const r = migrateMcpEntries(AMC, misfiled);
    expect(r.changed.some((c) => c.where.includes(proj))).toBe(false);
    expect(r.skipped.some((s) => s.includes("filed the new entry under another project"))).toBe(
      true,
    );

    const failing = {
      ...deps,
      localMcp: {
        ...fake.local,
        add: () => {
          throw new Error("claude mcp add-json failed: boom");
        },
      },
    };
    expect(migrateMcpEntries(AMC, failing).skipped.some((s) => s.includes("boom"))).toBe(true);
  });
});
