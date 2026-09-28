import { describe, expect, test } from "bun:test";
import { crewRole, isRequestDecisionTool, psAncestry, SPAWN_TOOLS, spawnLabel } from "../src/crew";

describe("crewRole", () => {
  test("teammates use the name embedded in their id", () => {
    expect(crewRole("ainvestigator-1a2b", "general-purpose")).toBe("investigator");
  });

  test("subagents fall back to agent_type, then a generic label", () => {
    expect(crewRole("a098142c5545132d2", "  Explore  ")).toBe("Explore");
    expect(crewRole("a098142c5545132d2", "   ")).toBe("subagent");
    expect(crewRole("a098142c5545132d2", 42)).toBe("subagent");
  });
});

describe("spawnLabel", () => {
  test("prefers the spawning call's name, trimmed and capped at 16 chars", () => {
    expect(spawnLabel({ name: "  reviewer ", description: "ignored" })).toBe("reviewer");
    expect(spawnLabel({ name: "a-very-long-agent-name-indeed" })).toBe("a-very-long-agen");
  });

  test("falls back to the description, cut at a word boundary", () => {
    expect(spawnLabel({ description: "Fix  the\ttests" })).toBe("Fix the tests");
    expect(spawnLabel({ description: "Card component tests" })).toBe("Card component");
    // No space late enough to cut on: hard cut at 16.
    expect(spawnLabel({ description: "Supercalifragilistic tests" })).toBe("Supercalifragili");
  });

  test("nothing usable yields undefined", () => {
    expect(spawnLabel(undefined)).toBeUndefined();
    expect(spawnLabel("Agent")).toBeUndefined();
    expect(spawnLabel({ name: " ", description: 3 })).toBeUndefined();
    expect(spawnLabel({ description: "   " })).toBeUndefined();
  });

  test("Agent and Task are the spawn tools", () => {
    expect([...SPAWN_TOOLS].sort()).toEqual(["Agent", "Task"]);
  });
});

test("isRequestDecisionTool matches the MCP tool under any server prefix", () => {
  expect(isRequestDecisionTool("mcp__mission-control__request_decision")).toBe(true);
  expect(isRequestDecisionTool("mcp__amc__request_decision")).toBe(true);
  expect(isRequestDecisionTool("mcp__mission-control__report_status")).toBe(false);
  expect(isRequestDecisionTool(undefined)).toBe(false);
});

describe("psAncestry", () => {
  test("walks the real process tree upward from this test process", () => {
    const chain = psAncestry(process.pid);
    expect(chain[0]).toBe(process.pid);
    expect(chain[1]).toBe(process.ppid);
    expect(chain.length).toBeLessThanOrEqual(8);
    expect(chain.every((p) => p > 1)).toBe(true);
    // Second walk is served from the ppid cache and must agree.
    expect(psAncestry(process.pid)).toEqual(chain);
  });

  test("respects depth", () => {
    expect(psAncestry(process.pid, 1)).toEqual([process.pid]);
    expect(psAncestry(process.pid, 0)).toEqual([]);
  });

  test("a pid that does not exist stops after itself", () => {
    // Above any real pid_max, so `ps` finds nothing.
    expect(psAncestry(99_999_999)).toEqual([99_999_999]);
  });

  test("init and below are never walked", () => {
    expect(psAncestry(1)).toEqual([]);
  });
});
