import { describe, expect, test } from "bun:test";
import type { CrewMember, Decision, Session } from "@amc/shared";
import { presented } from "../src/components/Station";
import { isReady } from "../src/util/crew";

const at = new Date(0).toISOString();

const member = (status: CrewMember["status"]): CrewMember => ({
  id: "asecurity-a484867aa788e408",
  kind: "teammate",
  role: "security",
  spriteSeed: 1,
  status,
  startedAt: at,
  lastSeenAt: at,
  toolCalls: 0,
});

const session = (status: Session["status"], crew: CrewMember[] = []): Session =>
  ({
    id: "s1",
    status,
    crew,
    persona: { name: "ORBIT", color: "green", spriteSeed: 1, voice: "pirate" },
    startedAt: at,
    lastSeenAt: at,
    stats: { toolCalls: 0 },
  }) as unknown as Session;

const card = { id: "d1", sessionId: "s1", source: "mcp" } as Decision;

// READY drives the badge, the idle chime and the "standing by" line (App readyIds).
describe("READY guard for sessions with crew out (#16)", () => {
  test("idle with nothing out is READY", () => {
    expect(isReady(session("idle"), [])).toBe(true);
    expect(isReady(session("idle", [member("done")]), [])).toBe(true);
  });

  test("idle with a working or waiting crew member is not READY and presents as working", () => {
    for (const st of ["working", "waiting_decision"] as const) {
      const s = session("idle", [member(st)]);
      expect(isReady(s, [])).toBe(false);
      expect(presented(s, []).s.status).toBe("working");
      expect(presented(s, []).label).not.toBe("READY");
    }
  });

  test("pending cards still win, and a non-idle session is never READY", () => {
    expect(isReady(session("idle"), [card])).toBe(false);
    expect(isReady(session("working"), [])).toBe(false);
    expect(presented(session("idle", [member("working")]), [card]).s.status).toBe(
      "waiting_decision",
    );
  });

  test("becomes READY the moment the last crew member is done", () => {
    const busy = session("idle", [member("working")]);
    const done = session("idle", [member("done")]);
    expect(isReady(busy, [])).toBe(false);
    expect(isReady(done, [])).toBe(true);
  });
});
