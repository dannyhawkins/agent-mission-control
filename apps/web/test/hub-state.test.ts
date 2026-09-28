import { describe, expect, test } from "bun:test";
import type { ServerEvent } from "@amc/shared";
import { type HubState, initialState, reduce } from "../src/hub/state";
import { decision, logEntry, session, T0 } from "./hub-fixtures";

const run = (events: ServerEvent[], from: HubState = initialState) => events.reduce(reduce, from);

const snapshot = (
  extra: Partial<Extract<ServerEvent, { type: "snapshot" }>["state"]> = {},
): ServerEvent => ({
  type: "snapshot",
  state: { sessions: [], decisions: [], log: [], serverTime: T0, ...extra },
});

describe("reduce", () => {
  test("snapshot replaces state, keeps only pending decisions, and counts resyncs", () => {
    const s = run([
      snapshot({
        sessions: [session("a"), session("b")],
        decisions: [decision("d1", "a"), decision("d2", "a", { status: "answered" })],
        log: [logEntry("l1")],
      }),
    ]);
    expect(Object.keys(s.sessions).sort()).toEqual(["a", "b"]);
    expect(Object.keys(s.decisions)).toEqual(["d1"]);
    expect(s.log.map((e) => e.id)).toEqual(["l1"]);
    expect(s.hydrated).toBe(true);
    expect(s.snapshots).toBe(1);
    expect(run([snapshot()], s).snapshots).toBe(2);
  });

  test("snapshot caps the log at the newest 500", () => {
    const log = Array.from({ length: 520 }, (_, i) => logEntry(`l${i}`));
    const s = run([snapshot({ log })]);
    expect(s.log).toHaveLength(500);
    expect(s.log[0]?.id).toBe("l20");
    expect(s.log.at(-1)?.id).toBe("l519");
  });

  test("snapshot drops caches for sessions that vanished while disconnected", () => {
    const before = run([
      snapshot({ sessions: [session("a"), session("b")] }),
      { type: "activity", sessionId: "a", line: "one", at: T0 },
      { type: "activity", sessionId: "b", line: "two", at: T0 },
    ]);
    const after = run([snapshot({ sessions: [session("a")] })], before);
    expect(Object.keys(after.activity)).toEqual(["a"]);
    expect(Object.keys(after.recent)).toEqual(["a"]);
  });

  test("snapshot seeds scrollback from recentActivity, only for live sessions, capped at 80", () => {
    const lines = Array.from({ length: 90 }, (_, i) => ({ at: T0, line: `l${i}` }));
    const s = run([
      snapshot({ sessions: [session("a")], recentActivity: { a: lines, ghost: lines } }),
    ]);
    expect(Object.keys(s.recent)).toEqual(["a"]);
    expect(s.recent.a).toHaveLength(80);
    expect(s.recent.a?.[0]?.line).toBe("l10");
  });

  test("session upserts", () => {
    const s = run([
      { type: "session", session: session("a", { statusLine: "first" }) },
      { type: "session", session: session("a", { statusLine: "second" }) },
    ]);
    expect(s.sessions.a?.statusLine).toBe("second");
  });

  test("session_removed takes its decisions, scrollback and activity with it", () => {
    const s = run([
      snapshot({
        sessions: [session("a"), session("b")],
        decisions: [decision("da", "a"), decision("db", "b")],
      }),
      { type: "activity", sessionId: "a", line: "x", at: T0 },
      { type: "session_removed", sessionId: "a" },
    ]);
    expect(Object.keys(s.sessions)).toEqual(["b"]);
    expect(Object.keys(s.decisions)).toEqual(["db"]);
    expect(s.recent.a).toBeUndefined();
    expect(s.activity.a).toBeUndefined();
  });

  test("decision upserts while pending and is removed on any other status", () => {
    const s1 = run([{ type: "decision", decision: decision("d1", "a") }]);
    expect(Object.keys(s1.decisions)).toEqual(["d1"]);
    const s2 = reduce(s1, {
      type: "decision",
      decision: decision("d1", "a", { status: "expired" }),
    });
    expect(s2.decisions).toEqual({});
    // Retiring an unknown decision is a no-op and keeps identity (no re-render).
    const s3 = reduce(s2, {
      type: "decision",
      decision: decision("zz", "a", { status: "answered" }),
    });
    expect(s3).toBe(s2);
  });

  test("log appends and dedupes by id", () => {
    const s = run([
      { type: "log", entry: logEntry("l1") },
      { type: "log", entry: logEntry("l2") },
    ]);
    const again = reduce(s, { type: "log", entry: logEntry("l1") });
    expect(again).toBe(s);
    expect(s.log.map((e) => e.id)).toEqual(["l1", "l2"]);
  });

  test("log keeps the newest 500 when appending", () => {
    const full = run([snapshot({ log: Array.from({ length: 500 }, (_, i) => logEntry(`l${i}`)) })]);
    const s = reduce(full, { type: "log", entry: logEntry("new") });
    expect(s.log).toHaveLength(500);
    expect(s.log.at(-1)?.id).toBe("new");
    expect(s.log[0]?.id).toBe("l1");
  });

  test("activity updates the ticker, pulse time and scrollback", () => {
    const at = "2026-09-25T10:05:00.000Z";
    const s = run([
      { type: "session", session: session("a") },
      { type: "activity", sessionId: "a", line: "Reading · x.ts", at },
    ]);
    expect(s.sessions.a?.statusLine).toBe("Reading · x.ts");
    expect(s.sessions.a?.lastSeenAt).toBe(at);
    expect(s.activity.a).toBe(Date.parse(at));
    expect(s.recent.a).toEqual([{ at, line: "Reading · x.ts" }]);
  });

  test("activity for an unknown session still records scrollback; a bad timestamp pulses now", () => {
    const before = Date.now();
    const s = run([{ type: "activity", sessionId: "ghost", line: "hi", at: "not a date" }]);
    expect(s.sessions).toEqual({});
    expect(s.recent.ghost).toHaveLength(1);
    expect(s.activity.ghost).toBeGreaterThanOrEqual(before);
  });

  test("activity scrollback is capped at 80 lines", () => {
    const events: ServerEvent[] = Array.from({ length: 85 }, (_, i) => ({
      type: "activity",
      sessionId: "a",
      line: `l${i}`,
      at: T0,
    }));
    const s = run(events);
    expect(s.recent.a).toHaveLength(80);
    expect(s.recent.a?.[0]?.line).toBe("l5");
  });
});
