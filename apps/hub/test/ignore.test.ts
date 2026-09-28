import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config";
import { restartTestHub, startTestHub, type TestHub } from "./helpers";

const IGN = "/tmp/amc-ignored";
const OBS = "obs-0000-0000-0000-000000000001";
const REAL = "real-0000-0000-0000-000000000001";

let t: TestHub;
afterEach(() => t?.stop());

describe("ignore list config", () => {
  test("env wins over config.json, which wins over the default; ~ is expanded", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "amc-cfg-"));
    try {
      expect(loadConfig({ AMC_DATA_DIR: dataDir }).ignoreCwd).toEqual([
        path.join(os.homedir(), ".claude-mem"),
      ]);
      fs.writeFileSync(
        path.join(dataDir, "config.json"),
        JSON.stringify({ ignoreCwd: ["~/scratch", "/opt/bots"] }),
      );
      expect(loadConfig({ AMC_DATA_DIR: dataDir }).ignoreCwd).toEqual([
        path.join(os.homedir(), "scratch"),
        "/opt/bots",
      ]);
      expect(loadConfig({ AMC_DATA_DIR: dataDir, AMC_IGNORE_CWD: "/a, ~/b" }).ignoreCwd).toEqual([
        "/a",
        path.join(os.homedir(), "b"),
      ]);
      // Set but empty: ignore nothing.
      expect(loadConfig({ AMC_DATA_DIR: dataDir, AMC_IGNORE_CWD: "" }).ignoreCwd).toEqual([]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("ignored sessions", () => {
  test("never become sessions, log entries or crew, even for later hooks without cwd", async () => {
    t = startTestHub({ AMC_IGNORE_CWD: IGN });
    await t.hook("SessionStart", 5000, { session_id: REAL, cwd: "/tmp/amc-ignored-not/proj" });
    await t.hook("SessionStart", 5001, { session_id: OBS, cwd: `${IGN}/observer-sessions` });
    await t.hook("PreToolUse", 5001, { session_id: OBS, tool_name: "Bash" });
    await t.hook("SubagentStart", 5001, { session_id: OBS, agent_id: "a098142c5545132d2" });
    await t.post("/api/status", { sessionId: OBS, line: "mcp online" });

    const s = await t.state();
    expect(s.sessions.map((x) => x.id)).toEqual([REAL]);
    expect(s.log.every((l) => l.sessionId === REAL)).toBe(true);
    expect(s.sessions[0]?.crew).toEqual([]);
  });

  test("telemetry from an ignored session is dropped", async () => {
    t = startTestHub({ AMC_IGNORE_CWD: IGN });
    await t.hook("SessionStart", 5001, { session_id: OBS, cwd: `${IGN}/observer-sessions` });
    const attr = (key: string, value: Record<string, unknown>) => ({ key, value });
    await t.post("/v1/logs", {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    attr("event.name", { stringValue: "api_request" }),
                    attr("session.id", { stringValue: OBS }),
                    attr("input_tokens", { intValue: "100" }),
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect((await t.state()).sessions).toHaveLength(0);
  });

  test("a nested claude under an ignored cwd is not attached as a child", async () => {
    const tree: Record<number, number> = { 6001: 6000, 6000: 1 };
    const ancestry = (pid: number) => {
      const out: number[] = [];
      for (let p = pid; p > 1; p = tree[p] ?? 1) out.push(p);
      return out;
    };
    t = startTestHub({ AMC_IGNORE_CWD: IGN }, undefined, { ancestry });
    await t.hook("SessionStart", 6000, { session_id: REAL, cwd: "/tmp/p" });
    await t.hook(
      "SessionStart",
      6002,
      { session_id: OBS, cwd: `${IGN}/obs` },
      { "x-claude-ppid": "6001" },
    );
    const s = await t.state();
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0]?.crew).toEqual([]);
  });

  test("the gate answers {} at once and decisions are refused with ignored: true", async () => {
    t = startTestHub({ AMC_IGNORE_CWD: IGN, AMC_GATE_TIMEOUT_MS: "5000" });
    const started = Date.now();
    const gate = await t.post("/api/hooks/gate", {
      session_id: OBS,
      cwd: `${IGN}/obs`,
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(gate.body).toEqual({});
    expect(Date.now() - started).toBeLessThan(1000);
    expect(t.hub.decisions.pending()).toHaveLength(0);

    // Known id, no cwd (MCP server without CLAUDE_PROJECT_DIR) and cwd only both refuse.
    for (const body of [{ sessionId: OBS }, { cwd: `${IGN}/other` }]) {
      const res = await t.post<{ ignored: boolean }>("/api/decisions", {
        ...body,
        source: "mcp",
        question: "q?",
        options: [{ label: "a" }, { label: "b" }],
      });
      expect(res.status).toBe(409);
      expect(res.body.ignored).toBe(true);
    }
    expect((await t.state()).sessions).toHaveLength(0);
  });

  test("rows written before a cwd was ignored are purged on start", async () => {
    t = startTestHub({ AMC_IGNORE_CWD: "" });
    await t.hook("SessionStart", 7000, { session_id: OBS, cwd: `${IGN}/obs` });
    await t.hook("SessionStart", 7001, { session_id: REAL, cwd: "/tmp/keep" });
    await t.post("/api/decisions", {
      sessionId: OBS,
      source: "mcp",
      question: "q?",
      options: [{ label: "a" }, { label: "b" }],
    });
    expect((await t.state()).sessions).toHaveLength(2);

    t = restartTestHub(t, { AMC_IGNORE_CWD: IGN });
    const s = await t.state();
    expect(s.sessions.map((x) => x.id)).toEqual([REAL]);
    expect(s.decisions).toHaveLength(0);
    expect(s.log.some((l) => l.sessionId === OBS)).toBe(false);
    // The purged id stays ignored even without a cwd.
    await t.hook("PreToolUse", 7000, { session_id: OBS, tool_name: "Bash" });
    expect((await t.state()).sessions).toHaveLength(1);
  });
});
