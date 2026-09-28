import { afterEach, describe, expect, test } from "bun:test";
import type { ServerEvent } from "@amc/shared";
import { restartTestHub, sleep, startTestHub, type TestHub } from "./helpers";

const SID = "88888888-aaaa-bbbb-cccc-000000000008";

let t: TestHub;
afterEach(() => t?.stop());

const session = async (id = SID) => (await t.state()).sessions.find((s) => s.id === id);

describe("engaged sessions", () => {
  test("a session is unengaged, with its log held, until the first prompt; then the log flushes in order", async () => {
    t = startTestHub();
    const events: ServerEvent[] = [];
    const b = t.hub.broadcaster;
    const origin = b.broadcast.bind(b);
    b.broadcast = (ev: ServerEvent) => {
      events.push(ev);
      origin(ev);
    };

    await t.hook("SessionStart", 1, { session_id: SID, cwd: "/tmp/e" });
    expect((await session())?.engaged).toBe(false);
    expect((await t.state()).log).toHaveLength(0);
    expect(events.some((e) => e.type === "log")).toBe(false);

    await t.hook("UserPromptSubmit", 1, { session_id: SID, prompt: "go" });
    expect((await session())?.engaged).toBe(true);
    await t.hook("Stop", 1, { session_id: SID });
    const kinds = (await t.state()).log.map((l) => l.kind);
    expect(kinds).toEqual(["session_start", "stop"]);
    expect(events.filter((e) => e.type === "log")).toHaveLength(2);
  });

  test("a main-thread tool, a crew member or a decision engages; a subagent tool alone does not count as main-thread", async () => {
    t = startTestHub();
    await t.hook("SessionStart", 1, { session_id: "a", cwd: "/tmp/a" });
    await t.hook("PreToolUse", 1, { session_id: "a", tool_name: "Read" });
    expect((await session("a"))?.engaged).toBe(true);

    await t.hook("SessionStart", 2, { session_id: "b", cwd: "/tmp/b" });
    await t.hook("SubagentStart", 2, {
      session_id: "b",
      agent_id: "a098142c5545132d2",
      agent_type: "Explore",
    });
    expect((await session("b"))?.engaged).toBe(true);

    await t.hook("SessionStart", 3, { session_id: "c", cwd: "/tmp/c" });
    await t.post("/api/decisions", {
      sessionId: "c",
      source: "mcp",
      question: "q?",
      options: [{ label: "a" }, { label: "b" }],
    });
    expect((await session("c"))?.engaged).toBe(true);
    const c = (await t.state()).log.filter((l) => l.sessionId === "c").map((l) => l.kind);
    expect(c).toEqual(["session_start", "decision_requested"]);
  });

  test("a session that ends unengaged leaves no trace, and its callsign is freed", async () => {
    t = startTestHub();
    await t.hook("SessionStart", 1, { session_id: SID, cwd: "/tmp/e" });
    const name = (await session())?.persona.name;
    await t.hook("SessionEnd", 1, { session_id: SID, reason: "exit" });
    await sleep(10);
    const state = await t.state();
    expect(state.sessions).toHaveLength(0);
    expect(state.log).toHaveLength(0);
    expect(t.hub.db.query("SELECT * FROM sessions").all()).toHaveLength(0);
    expect(t.hub.db.query("SELECT * FROM personas").all()).toHaveLength(0);
    expect(name).toBeString();
  });

  test("held entries are capped, and rows from before the flag load as engaged", async () => {
    t = startTestHub();
    await t.hook("SessionStart", 1, { session_id: SID, cwd: "/tmp/e" });
    for (let i = 0; i < 30; i++) {
      await t.hook("Notification", 1, {
        session_id: SID,
        notification_type: "auth_success",
        message: `n${i}`,
      });
    }
    await t.hook("UserPromptSubmit", 1, { session_id: SID, prompt: "go" });
    expect((await t.state()).log).toHaveLength(20);

    // Simulate an old row without the flag.
    const row = t.hub.db
      .query<{ json: string }, [string]>("SELECT json FROM sessions WHERE id = ?")
      .get(SID);
    const rec = JSON.parse(row?.json ?? "{}");
    delete rec.session.engaged;
    t.hub.db.run("UPDATE sessions SET json = ? WHERE id = ?", [JSON.stringify(rec), SID]);
    t = restartTestHub(t);
    expect((await session())?.engaged).toBe(true);
  });
});
