import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Session } from "@amc/shared";
import { spawnLabel } from "../src/crew";
import { teammateName } from "../src/teams";
import { startTestHub, type TestHub } from "./helpers";

// Standby teammates (#19). Ids follow the shapes observed on 2.1.281.
const LEAD = "9ef092c5-cc47-4adb-8ee9-5e1b96a25e8b";
const MATE = "asecurity-a484867aa788e408";
const SUB = "a098142c5545132d2";
const PID = 63723;

let t: TestHub;
afterEach(() => t?.stop());

const session = async (id = LEAD): Promise<Session> => {
  const s = (await t.state()).sessions.find((x) => x.id === id);
  if (!s) throw new Error(`no session ${id}`);
  return s;
};
const mate = async () => (await session()).crew.find((m) => m.id === MATE);

const hook = (event: string, extra: Record<string, unknown> = {}) =>
  t.hook(event, PID, { session_id: LEAD, ...extra });
const mateHook = (event: string, extra: Record<string, unknown> = {}) =>
  hook(event, { agent_id: MATE, agent_type: "general-purpose", ...extra });

/** Lays out <claudeHome>/teams/<team>/config.json and the lead's transcript + teammate meta. */
function writeTeam(opts: { members?: string[]; leadSessionId?: string; meta?: boolean } = {}) {
  const home = t.hub.config.claudeHome;
  const teamDir = path.join(home, "teams", "session-8ea4ad4f");
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, "config.json"),
    JSON.stringify({
      name: "session-8ea4ad4f",
      leadAgentId: "team-lead@session-8ea4ad4f",
      leadSessionId: opts.leadSessionId ?? "8ea4ad4f-8f5b-4b89-b6fc-448206e2b4db",
      members: (opts.members ?? ["team-lead", "security"]).map((name) => ({
        agentId: `${name}@session-8ea4ad4f`,
        name,
        agentType: name === "team-lead" ? "team-lead" : "general-purpose",
      })),
    }),
  );
  const projDir = path.join(home, "projects", "-tmp-p");
  const subDir = path.join(projDir, LEAD, "subagents");
  fs.mkdirSync(subDir, { recursive: true });
  if (opts.meta !== false) {
    fs.writeFileSync(
      path.join(subDir, `agent-${MATE}.meta.json`),
      JSON.stringify({
        agentType: "security",
        name: "security",
        taskKind: "in_process_teammate",
        teamName: "session-8ea4ad4f",
      }),
    );
    fs.writeFileSync(path.join(subDir, `agent-${MATE}.jsonl`), "{}\n");
  }
  t.hub.sessions.teams.invalidate();
  return { teamDir, transcript: path.join(projDir, `${LEAD}.jsonl`) };
}

describe("teammate id heuristics", () => {
  test("names come out whole, hyphens included", () => {
    expect(teammateName("athread-inventory-8caab213f214beb8")).toBe("thread-inventory");
    expect(teammateName(MATE)).toBe("security");
    expect(teammateName("aItemsFromExApi-c8ab681553d9ff5b")).toBe("ItemsFromExApi");
  });

  test("spawn labels prefer name, else a word-cut description", () => {
    expect(spawnLabel({ name: "reviewer", description: "Review the diff" })).toBe("reviewer");
    expect(spawnLabel({ description: "Fix login bug" })).toBe("Fix login bug");
    expect(spawnLabel({ description: "Investigate the flaky websocket test" })).toBe(
      "Investigate the",
    );
    expect(spawnLabel({ subagent_type: "Explore" })).toBeUndefined();
  });
});

describe("standby teammates", () => {
  test("stop and idle put a teammate on standby; the lead may go idle; its next hook wakes it", async () => {
    t = startTestHub();
    await hook("SessionStart");
    await mateHook("SubagentStart");
    await mateHook("PreToolUse", { tool_name: "Read" });
    await hook("Stop");
    expect((await session()).status).toBe("working"); // held by a working teammate (#16)

    await mateHook("SubagentStop");
    await mateHook("TeammateIdle", { teammate_name: "security" });
    const m = await mate();
    expect(m).toMatchObject({ kind: "teammate", role: "security", status: "standby" });
    expect(m?.endedAt).toBeUndefined();
    let s = await session();
    expect(s.status).toBe("idle");
    expect(s.blockedSince).toBeString();
    // Standby is not a mission-log event.
    const log = (await t.state()).log.map((l) => l.text);
    expect(log.some((l) => /TeammateIdle|standby/i.test(l))).toBe(false);

    // Past the grace period it is still in the bay.
    t.hub.sessions.sweep(Date.now() + 5 * 60_000);
    expect((await mate())?.status).toBe("standby");

    await mateHook("PreToolUse", { tool_name: "Bash" });
    expect((await mate())?.status).toBe("working");
    s = await session();
    expect(s.status).toBe("working");
  });

  test("subagents keep done + grace fade", async () => {
    t = startTestHub({}, undefined, { crewGraceMs: 60_000 });
    await hook("SessionStart");
    await hook("SubagentStart", { agent_id: SUB, agent_type: "Explore" });
    await hook("SubagentStop", { agent_id: SUB, agent_type: "Explore" });
    expect((await session()).crew[0]?.status).toBe("done");
    t.hub.sessions.sweep(Date.now() + 61_000);
    expect((await session()).crew).toHaveLength(0);
  });

  test("the #16 stale timeout skips standby teammates", async () => {
    t = startTestHub();
    await hook("SessionStart");
    await mateHook("SubagentStart");
    await mateHook("SubagentStop");
    t.hub.sessions.sweep(Date.now() + t.hub.config.crewStaleMs + 1_000);
    expect((await mate())?.status).toBe("standby");
  });

  test("a long silence removes a standby teammate", async () => {
    t = startTestHub({ AMC_TEAMMATE_STANDBY_MS: "120000" });
    await hook("SessionStart");
    await mateHook("SubagentStart");
    await mateHook("SubagentStop");
    t.hub.sessions.sweep(Date.now() + 60_000);
    expect(await mate()).toBeDefined();
    t.hub.sessions.sweep(Date.now() + 121_000);
    expect(await mate()).toBeUndefined();
  });

  test("the lead session ending takes standby teammates with it", async () => {
    t = startTestHub({}, undefined, { crewGraceMs: 60_000 });
    await hook("SessionStart");
    await mateHook("SubagentStart");
    await mateHook("SubagentStop");
    await hook("SessionEnd", { reason: "exit" });
    expect((await mate())?.status).toBe("done");
    t.hub.sessions.sweep(Date.now() + 61_000);
    expect(await mate()).toBeUndefined();
  });
});

describe("team roster reconcile", () => {
  test("labels from the meta file, removal when the roster drops the member", async () => {
    t = startTestHub();
    const { teamDir, transcript } = writeTeam();
    await hook("SessionStart", { transcript_path: transcript });
    await mateHook("SubagentStart");
    await mateHook("SubagentStop");
    expect(await mate()).toMatchObject({ role: "security", team: "session-8ea4ad4f" });

    t.hub.sessions.sweep();
    expect((await mate())?.status).toBe("standby");

    const cfg = JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8"));
    cfg.members = cfg.members.filter((m: { name: string }) => m.name !== "security");
    fs.writeFileSync(path.join(teamDir, "config.json"), JSON.stringify(cfg));
    t.hub.sessions.teams.invalidate();
    t.hub.sessions.sweep();
    expect(await mate()).toBeUndefined();
  });

  test("a deleted team removes its standby teammates", async () => {
    t = startTestHub();
    const { teamDir, transcript } = writeTeam();
    await hook("SessionStart", { transcript_path: transcript });
    await mateHook("SubagentStart");
    await mateHook("SubagentStop");
    fs.rmSync(teamDir, { recursive: true });
    t.hub.sessions.teams.invalidate();
    t.hub.sessions.sweep();
    expect(await mate()).toBeUndefined();
  });

  test("without a meta file the team is found by leadSessionId", async () => {
    t = startTestHub();
    const { transcript } = writeTeam({ meta: false, leadSessionId: LEAD, members: ["team-lead"] });
    await hook("SessionStart", { transcript_path: transcript });
    await mateHook("SubagentStart");
    await mateHook("SubagentStop");
    t.hub.sessions.sweep();
    expect(await mate()).toBeUndefined();
  });

  test("an unknown team leaves standby teammates alone", async () => {
    t = startTestHub();
    await hook("SessionStart");
    await mateHook("SubagentStart");
    await mateHook("SubagentStop");
    t.hub.sessions.sweep();
    expect((await mate())?.status).toBe("standby");
  });

  test("teammates found on disk are seeded on standby, and not re-seeded once removed", async () => {
    t = startTestHub({}, undefined, { crewGraceMs: 60_000 });
    const { transcript } = writeTeam();
    await hook("SessionStart", { transcript_path: transcript });
    await hook("UserPromptSubmit", { prompt: "go" });
    t.hub.sessions.sweep();
    expect(await mate()).toMatchObject({
      kind: "teammate",
      role: "security",
      team: "session-8ea4ad4f",
      status: "standby",
    });
    expect((await session()).status).toBe("working"); // SessionStart; standby does not hold it

    await hook("SessionEnd", { reason: "exit" });
    t.hub.sessions.sweep(Date.now() + 61_000);
    expect(await mate()).toBeUndefined();
  });
});

describe("subagent spawn labels", () => {
  test("the parent's Agent call names the next SubagentStart of that type, FIFO", async () => {
    t = startTestHub();
    await hook("SessionStart");
    await hook("PreToolUse", {
      tool_name: "Agent",
      tool_input: { description: "Find crew code", subagent_type: "Explore", prompt: "x" },
    });
    await hook("PreToolUse", {
      tool_name: "Agent",
      tool_input: { name: "reviewer", description: "Review the diff", prompt: "y" },
    });
    await hook("PreToolUse", {
      tool_name: "Agent",
      tool_input: { description: "Second explore", subagent_type: "Explore", prompt: "z" },
    });
    // Teammate spawns are not queued.
    await hook("PreToolUse", {
      tool_name: "Agent",
      tool_input: { name: "security", team_name: "t", description: "Audit", prompt: "w" },
    });
    await hook("SubagentStart", { agent_id: "a1111111111111111", agent_type: "general-purpose" });
    await hook("SubagentStart", { agent_id: "a2222222222222222", agent_type: "Explore" });
    await hook("SubagentStart", { agent_id: "a3333333333333333", agent_type: "Explore" });
    await hook("PreToolUse", {
      agent_id: "a2222222222222222",
      agent_type: "Explore",
      tool_name: "Grep",
    });
    const crew = (await session()).crew;
    const label = (id: string) => crew.find((m) => m.id === id)?.label;
    expect(label("a1111111111111111")).toBe("reviewer");
    expect(label("a2222222222222222")).toBe("Find crew code");
    expect(label("a3333333333333333")).toBe("Second explore");
    expect(crew.find((m) => m.id === "a2222222222222222")?.role).toBe("Explore");
  });
});
