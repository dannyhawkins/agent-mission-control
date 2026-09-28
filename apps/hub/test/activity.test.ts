import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import { maskSecrets, toolTarget } from "../src/detail";
import { restartTestHub, sleep, startTestHub, type TestHub } from "./helpers";

const CWD = "/Users/u/Code/amc";
const SID = "aaaaaaaa-aaaa-bbbb-cccc-00000000000a";

describe("toolTarget", () => {
  test("files relative to the session cwd, else ~-shortened", () => {
    expect(toolTarget("Read", { file_path: `${CWD}/docs/runbook.md` }, CWD)).toBe(
      "docs/runbook.md",
    );
    expect(
      toolTarget(
        "Edit",
        { file_path: `${CWD}/apps/web/src/hub/state.ts`, old_string: "secret", new_string: "x" },
        CWD,
      ),
    ).toBe("apps/web/src/hub/state.ts");
    expect(
      toolTarget("Write", { file_path: `${os.homedir()}/notes.md`, content: "hunter2" }, CWD),
    ).toBe("~/notes.md");
  });

  test("Bash: description if given, else the first 60 chars of the command, secrets masked", () => {
    expect(toolTarget("Bash", { command: "bun test apps/hub", description: "Run hub tests" })).toBe(
      "Run hub tests",
    );
    expect(toolTarget("Bash", { command: "bun test apps/hub" })).toBe("bun test apps/hub");
    const long = toolTarget("Bash", { command: `echo ${"x".repeat(100)}` });
    expect(long?.length).toBe(60);
    expect(long?.endsWith("...")).toBe(true);
    expect(toolTarget("Bash", { command: "GITHUB_TOKEN=ghp_abc123 gh pr list" })).toBe(
      "GITHUB_TOKEN=*** gh pr list",
    );
  });

  test("masking covers flags, auth headers and URL credentials", () => {
    expect(
      maskSecrets(
        "curl -H 'Authorization: Bearer abc.def' --password hunter2 https://me:pw@host/x DB_PASSWORD='p w'",
      ),
    ).toBe("curl -H 'Authorization: ***' --password *** https://me:***@host/x DB_PASSWORD=***");
  });

  test("search, web, agents and MCP tools", () => {
    expect(toolTarget("Grep", { pattern: "RECENT_CAP", path: `${CWD}/apps/web` }, CWD)).toBe(
      '"RECENT_CAP" in apps/web',
    );
    expect(toolTarget("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(toolTarget("WebFetch", { url: "https://code.claude.com/docs/en/hooks?x=1#top" })).toBe(
      "code.claude.com/docs/en/hooks",
    );
    expect(toolTarget("WebSearch", { query: "bun unix socket" })).toBe('"bun unix socket"');
    expect(toolTarget("Agent", { description: "Audit billing", subagent_type: "Explore" })).toBe(
      "Audit billing",
    );
    expect(toolTarget("mcp__claude_ai_Slack__slack_read_channel", {})).toBe("slack_read_channel");
    expect(toolTarget("SomethingNew", { a: 1 })).toBeUndefined();
  });
});

describe("station history", () => {
  let t: TestHub;
  afterEach(() => t?.stop());

  test("one line per call with its target, failures marked, all kept in order and served in the snapshot", async () => {
    t = startTestHub();
    await t.hook("SessionStart", 1, { session_id: SID, cwd: CWD });
    await t.hook("PreToolUse", 1, {
      session_id: SID,
      tool_name: "Read",
      tool_input: { file_path: `${CWD}/docs/runbook.md` },
    });
    await t.hook("PostToolUse", 1, {
      session_id: SID,
      tool_name: "Read",
      tool_input: { file_path: `${CWD}/docs/runbook.md` },
    });
    await t.hook("PreToolUse", 1, {
      session_id: SID,
      tool_name: "Bash",
      tool_input: { command: "bun test apps/hub" },
    });
    await t.hook("PostToolUseFailure", 1, {
      session_id: SID,
      tool_name: "Bash",
      tool_input: { command: "bun test apps/hub" },
    });
    await t.hook("PreToolUse", 1, {
      session_id: SID,
      agent_id: "a098142c5545132d2",
      agent_type: "Explore",
      tool_name: "Grep",
      tool_input: { pattern: "RECENT_CAP" },
    });
    await sleep(300);
    const lines = (await t.state()).recentActivity?.[SID]?.map((a) => a.line) ?? [];
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEndWith(" · docs/runbook.md");
    expect(lines[1]).toEndWith(" · bun test apps/hub");
    expect(lines[2]).toBe("✗ Bash failed · bun test apps/hub");
    expect(lines[3]).toStartWith("Explore: ");
    expect(lines[3]).toEndWith(' · "RECENT_CAP"');

    // Survives a hub restart.
    t = restartTestHub(t);
    expect((await t.state()).recentActivity?.[SID]?.map((a) => a.line)).toEqual(lines);
  });

  test("capped at 80 per session, and dropped with the session", async () => {
    t = startTestHub();
    await t.hook("SessionStart", 1, { session_id: SID, cwd: CWD });
    for (let i = 0; i < 90; i++) {
      await t.hook("PreToolUse", 1, {
        session_id: SID,
        tool_name: "Read",
        tool_input: { file_path: `${CWD}/f${i}.ts` },
      });
    }
    await sleep(300);
    const lines = (await t.state()).recentActivity?.[SID] ?? [];
    expect(lines).toHaveLength(80);
    expect(lines.at(-1)?.line).toEndWith(" · f89.ts");
    t = restartTestHub(t);
    expect((await t.state()).recentActivity?.[SID]).toHaveLength(80);

    // A noise session's lines go with it.
    await t.hook("SessionStart", 2, { session_id: "noise", cwd: "/tmp/n" });
    await t.hook("Notification", 2, { session_id: "noise", notification_type: "x", message: "m" });
    await sleep(300);
    await t.hook("SessionEnd", 2, { session_id: "noise" });
    expect(t.hub.db.query("SELECT * FROM activity WHERE session_id = 'noise'").all()).toHaveLength(
      0,
    );
  });
});
