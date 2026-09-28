import { describe, expect, test } from "bun:test";
import type { CrewMember, Decision, Session } from "@amc/shared";
import { AnswerError, MessageError } from "../src/hub/errors";
import { generateSprite, isBandRow, SPRITE_SIZE } from "../src/sprite/generator";
import {
  crewBusy,
  crewTint,
  floorView,
  seedFrom,
  shortRole,
  splitRolePrefix,
} from "../src/util/crew";
import { stationTier, tierRank, waitingSince } from "../src/util/escalation";
import { lighten, PERSONA_HEX, shade } from "../src/util/theme";
import {
  fmtClock,
  fmtCost,
  fmtElapsed,
  fmtTime,
  fmtTokens,
  isToday,
  shortPath,
} from "../src/util/time";

const T0 = Date.parse("2026-09-25T12:00:00Z");
const ago = (ms: number) => new Date(T0 - ms).toISOString();
const MIN = 60_000;

const session = (id: string, extra: Partial<Session> = {}): Session =>
  ({
    id,
    persona: { color: "amber", spriteSeed: 7, callsign: id },
    status: "working",
    cwd: `/tmp/${id}`,
    project: id,
    startedAt: ago(10 * MIN),
    lastSeenAt: ago(0),
    statusLine: "",
    stats: { toolCalls: 3, inputTokens: 0, outputTokens: 0, costUsd: 0, decisionsAnswered: 0 },
    ...extra,
  }) as Session;

const decision = (id: string, sessionId: string, extra: Partial<Decision> = {}): Decision =>
  ({
    id,
    sessionId,
    source: "mcp",
    question: "?",
    options: [],
    urgency: "normal",
    status: "pending",
    createdAt: ago(0),
    allowFreeText: true,
    ...extra,
  }) as Decision;

const member = (id: string, status: CrewMember["status"], role = id): CrewMember => ({
  id,
  kind: "teammate",
  role,
  spriteSeed: 1,
  status,
  startedAt: ago(0),
  lastSeenAt: ago(0),
  toolCalls: 0,
});

describe("escalation", () => {
  test("tiers rank calm < amber < red < alarm", () => {
    expect(
      ["alarm", "calm", "red", "amber"].sort((a, b) => tierRank(a as never) - tierRank(b as never)),
    ).toEqual(["calm", "amber", "red", "alarm"]);
  });

  test("a permission prompt escalates on blockedSince; idle never does", () => {
    const blocked = session("s", { status: "waiting_permission", blockedSince: ago(6 * MIN) });
    expect(stationTier(blocked, [], T0)).toBe("red");
    expect(waitingSince(blocked, [])).toBe(T0 - 6 * MIN);
    const idle = session("s", { status: "idle", blockedSince: ago(30 * MIN) });
    expect(stationTier(idle, [], T0)).toBe("calm");
    expect(waitingSince(idle, [])).toBeUndefined();
  });

  test("the oldest pending decision wins", () => {
    const s = session("s", { status: "waiting_decision" });
    const ds = [
      decision("a", "s", { createdAt: ago(MIN) }),
      decision("b", "s", { createdAt: ago(11 * MIN) }),
    ];
    expect(stationTier(s, ds, T0)).toBe("alarm");
    expect(waitingSince(s, ds)).toBe(T0 - 11 * MIN);
  });

  test("a working session only escalates on crew decisions", () => {
    const s = session("s", { status: "working", blockedSince: ago(20 * MIN) });
    const own = decision("a", "s", { createdAt: ago(3 * MIN) });
    const crew = decision("b", "s", { createdAt: ago(3 * MIN), agentId: "ax-1234" });
    expect(stationTier(s, [own], T0)).toBe("calm");
    expect(stationTier(s, [own, crew], T0)).toBe("amber");
    expect(waitingSince(s, [own])).toBeUndefined();
    expect(waitingSince(s, [own, crew])).toBe(T0 - 3 * MIN);
  });

  test("offline stations are always calm", () => {
    const s = session("s", { status: "offline" });
    expect(stationTier(s, [decision("a", "s", { createdAt: ago(60 * MIN) })], T0)).toBe("calm");
    expect(waitingSince(s, [decision("a", "s")])).toBeUndefined();
  });

  test("unparseable timestamps are ignored", () => {
    const s = session("s", { status: "waiting_decision" });
    expect(waitingSince(s, [decision("a", "s", { createdAt: "garbage" })])).toBeUndefined();
  });
});

describe("time formatting", () => {
  test("clock and elapsed", () => {
    expect(fmtClock(new Date(2026, 0, 2, 3, 4, 5))).toBe("03:04:05");
    expect(fmtTime("nope")).toBe("--:--:--");
    expect(fmtTime(new Date(2026, 0, 2, 13, 14, 15).toISOString())).toBe("13:14:15");
    expect(fmtElapsed(-5)).toBe("00:00");
    expect(fmtElapsed(65_000)).toBe("01:05");
    expect(fmtElapsed(3_723_000)).toBe("1:02:03");
  });

  test("tokens and cost", () => {
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1500)).toBe("1.5k");
    expect(fmtTokens(2_500_000)).toBe("2.5M");
    expect(fmtCost(1.234)).toBe("$1.23");
    expect(fmtCost(12.6)).toBe("$13");
  });

  test("isToday and shortPath", () => {
    const now = new Date(2026, 8, 25, 12);
    expect(isToday(new Date(2026, 8, 25, 1).toISOString(), now)).toBe(true);
    expect(isToday(new Date(2026, 8, 24, 23).toISOString(), now)).toBe(false);
    expect(shortPath("/Users/sam/Code/x")).toBe("~/Code/x");
    expect(shortPath("/home/ci/work")).toBe("~/work");
    expect(shortPath("/opt/app")).toBe("/opt/app");
  });
});

describe("theme", () => {
  test("shade darkens and lighten mixes toward white", () => {
    expect(shade("#ffffff", 0.5)).toBe("rgb(127,127,127)");
    expect(shade(PERSONA_HEX.red, 1)).toBe("rgb(255,59,59)");
    expect(lighten("#000000", 0.5)).toBe("rgb(127,127,127)");
    expect(lighten("#ff0000", 0)).toBe("rgb(255,0,0)");
    expect(crewTint("amber")).toBe(lighten(PERSONA_HEX.amber, 0.45));
  });
});

describe("crew helpers", () => {
  test("shortRole picks the distinctive segment", () => {
    expect(shortRole("general-purpose")).toBe("GENERAL");
    expect(shortRole("child_session")).toBe("CLAUDE");
    expect(shortRole("plugin:code-reviewer")).toBe("REVIEWER");
    expect(shortRole("frontend-crew")).toBe("FRONTEND");
    expect(shortRole("extraordinarily")).toBe("EXTRAORD");
  });

  test("seedFrom is stable FNV-1a", () => {
    expect(seedFrom("")).toBe(0x811c9dc5);
    expect(seedFrom("abc")).toBe(seedFrom("abc"));
    expect(seedFrom("abc")).not.toBe(seedFrom("abd"));
  });

  test("crewBusy ignores standby and done", () => {
    expect(crewBusy(session("s"))).toBe(false);
    expect(crewBusy(session("s", { crew: [member("a", "standby"), member("b", "done")] }))).toBe(
      false,
    );
    expect(crewBusy(session("s", { crew: [member("a", "waiting_decision")] }))).toBe(true);
  });

  test("splitRolePrefix only splits on a role in the bay", () => {
    const crew = [member("ax-1", "working", "plugin:code-reviewer")];
    expect(splitRolePrefix("REVIEWER: looking", crew)?.rest).toBe("looking");
    expect(splitRolePrefix("plugin:code-reviewer: hi", crew)?.prefix).toBe(
      "plugin:code-reviewer: ",
    );
    expect(splitRolePrefix("Someone: hi", crew)).toBeUndefined();
    expect(splitRolePrefix("no prefix here", crew)).toBeUndefined();
    expect(splitRolePrefix("REVIEWER: hi", [])).toBeUndefined();
  });
});

describe("floorView", () => {
  test("a nested claude folds into its live parent with a synthesised crew member", () => {
    const parent = session("p");
    const child = session("c", { parentSessionId: "p", status: "waiting_permission" });
    const view = floorView([parent, child], [decision("d", "c")]);
    expect(view.stations.map((s) => s.id)).toEqual(["p"]);
    const synth = view.stations[0]?.crew?.[0];
    expect(synth).toMatchObject({ id: "c", kind: "child_session", status: "waiting_decision" });
    expect(view.decisions.p?.[0]).toMatchObject({
      sessionId: "p",
      agentId: "c",
      agentRole: "child_session",
    });
  });

  test("a child already in the parent's crew is not duplicated", () => {
    const parent = session("p", { crew: [{ ...member("c", "working"), kind: "child_session" }] });
    const child = session("c", { parentSessionId: "p" });
    expect(floorView([parent, child], []).stations[0]?.crew).toHaveLength(1);
  });

  test("offline children show done; orphans of an offline parent get their own station", () => {
    const live = session("p");
    const done = session("c", { parentSessionId: "p", status: "offline" });
    expect(floorView([live, done], []).stations[0]?.crew?.[0]?.status).toBe("done");

    const gone = session("p", { status: "offline" });
    const orphan = session("c", { parentSessionId: "p" });
    const view = floorView([gone, orphan], [decision("d", "c")]);
    expect(view.stations.map((s) => s.id)).toEqual(["c"]);
    expect(view.offShift.map((s) => s.id)).toEqual(["p"]);
    expect(view.decisions.c?.[0]?.agentId).toBeUndefined();
  });

  test("unengaged sessions are hidden everywhere", () => {
    const view = floorView([session("bg", { engaged: false }), session("x")], []);
    expect(view.stations.map((s) => s.id)).toEqual(["x"]);
  });
});

describe("errors", () => {
  test("carry their kind", () => {
    expect(new AnswerError("not_waiting", "gone").kind).toBe("not_waiting");
    const m = new MessageError("rate_limited", "slow down");
    expect(m).toBeInstanceOf(Error);
    expect([m.kind, m.message]).toEqual(["rate_limited", "slow down"]);
  });
});

describe("sprite generator", () => {
  test("is deterministic, mirrored, and blinks by clearing the eye", () => {
    const a = generateSprite(42);
    expect(generateSprite(42)).toEqual(a);
    expect(a.open).toHaveLength(SPRITE_SIZE * SPRITE_SIZE);
    for (let y = 0; y < SPRITE_SIZE; y++) {
      for (let x = 0; x < SPRITE_SIZE / 2; x++) {
        expect(a.open[y * SPRITE_SIZE + x]).toBe(a.open[y * SPRITE_SIZE + SPRITE_SIZE - 1 - x]);
      }
    }
    expect(a.open[4 * SPRITE_SIZE + 3]).toBe(2);
    expect(a.blink.includes(2)).toBe(false);
    expect(generateSprite(0)).toEqual(generateSprite(0));
  });

  test("every third row bands", () => {
    expect([0, 12, 24, 36].map(isBandRow)).toEqual([true, false, false, true]);
  });
});
