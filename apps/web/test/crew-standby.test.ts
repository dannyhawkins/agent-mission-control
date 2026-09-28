import { describe, expect, test } from "bun:test";
import type { CrewMember, Session } from "@amc/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CrewBay, crewLabel, sortCrew } from "../src/components/CrewBay";
import { isReady } from "../src/util/crew";

const at = new Date(0).toISOString();

const member = (
  id: string,
  status: CrewMember["status"],
  extra: Partial<CrewMember> = {},
): CrewMember => ({
  id,
  kind: "teammate",
  role: id,
  spriteSeed: 1,
  status,
  startedAt: at,
  lastSeenAt: at,
  toolCalls: 0,
  ...extra,
});

const crew = [
  member("sleepy", "standby"),
  member("busy", "working"),
  member("gone", "done"),
  member("asking", "waiting_decision"),
];

describe("standby crew in the bay (#19)", () => {
  test("order is waiting, working, standby, done", () => {
    expect(sortCrew(crew).map((m) => m.id)).toEqual(["asking", "busy", "sleepy", "gone"]);
  });

  test("standby renders with its status, role label and tooltip", () => {
    const html = renderToStaticMarkup(createElement(CrewBay, { crew, tint: "#fff" }));
    const order = [...html.matchAll(/data-status="(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["waiting_decision", "working", "standby", "done"]);
    expect(html).toMatch(/data-status="standby" title="[^"]*standby \(between tasks\)/);
    expect(html).toContain(">SLEEPY<");
  });

  test("standby does not hold READY", () => {
    const s = { status: "idle", crew: [member("sleepy", "standby")] } as unknown as Session;
    expect(isReady(s, [])).toBe(true);
  });

  test("subagents show their spawn label, uppercased", () => {
    expect(crewLabel(member("a1", "working", { kind: "subagent", label: "Fix login bug" }))).toBe(
      "FIX LOGIN BUG",
    );
    expect(crewLabel(member("a2", "working", { kind: "subagent", role: "general-purpose" }))).toBe(
      "GENERAL",
    );
  });
});
