import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db";
import { CALLSIGNS, derivePersona, PersonaStore } from "../src/personas";
import { phrase } from "../src/voice";

describe("personas", () => {
  test("same session id always derives the same persona", () => {
    const a = derivePersona("session-abc");
    const b = derivePersona("session-abc");
    expect(a).toEqual(b);
    expect(CALLSIGNS).toContain(a.name);
    expect(a.tagline.length).toBeGreaterThan(0);
  });

  test("different sessions spread across names", () => {
    const names = new Set(Array.from({ length: 60 }, (_, i) => derivePersona(`s-${i}`).name));
    expect(names.size).toBeGreaterThan(20);
  });

  test("advances past callsigns taken by live sessions", () => {
    const base = derivePersona("collide-me");
    const bumped = derivePersona("collide-me", [base.name]);
    expect(bumped.name).not.toBe(base.name);
    expect(bumped.color).toBe(base.color);
    expect(bumped.voice).toBe(base.voice);
    expect(bumped.spriteSeed).toBe(base.spriteSeed);
    // With every name taken we still return something rather than looping forever.
    const saturated = derivePersona("collide-me", CALLSIGNS);
    expect(CALLSIGNS).toContain(saturated.name);
  });

  test("store persists the first-seen persona even if names later free up", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amc-persona-"));
    const db = openDb(dir);
    const store = new PersonaStore(db);
    const natural = derivePersona("x1").name;
    const first = store.getOrCreate("x1", [natural]);
    expect(first.name).not.toBe(natural);
    const again = store.getOrCreate("x1", []);
    expect(again.name).toBe(first.name);
    db.close();
    const reopened = new PersonaStore(openDb(dir));
    expect(reopened.get("x1")?.name).toBe(first.name);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("rekey moves a provisional persona to the real session id", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amc-persona-"));
    const store = new PersonaStore(openDb(dir));
    const p = store.getOrCreate("pid:123", []);
    const moved = store.rekey("pid:123", "real-id");
    expect(moved?.name).toBe(p.name);
    expect(moved?.sessionId).toBe("real-id");
    expect(store.get("pid:123")).toBeUndefined();
    expect(store.get("real-id")?.name).toBe(p.name);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("voice", () => {
  test("substitutes tool names and stays deterministic", () => {
    const a = phrase("gungho", "NOVA", { kind: "tool_start", tool: "Bash" });
    const b = phrase("gungho", "NOVA", { kind: "tool_start", tool: "Bash" });
    expect(a).toBe(b);
    expect(a).toMatch(/SHELL COMMAND/);
    expect(phrase("robot", "BOLT", { kind: "decision_answered", answer: "Postgres" })).toContain(
      "Postgres",
    );
    expect(phrase("pirate", "OTTER", { kind: "session_start" })).toBeString();
  });
});

describe("hublog", () => {
  test("levels and formatting", async () => {
    const { createLogger, shortPath } = await import("../src/hublog");
    const lines: string[] = [];
    const quiet = createLogger("quiet", (l) => lines.push(l));
    quiet.info("hook", "SessionStart", "NOVA");
    expect(lines).toEqual([]);
    const info = createLogger("info", (l) => lines.push(l));
    info.event("hook", ["SessionStart", "NOVA", undefined, "~/x"], () => "keys=[a]");
    expect(lines[0]).toMatch(/^\d\d:\d\d:\d\d hook {6}SessionStart {2}NOVA {2}~\/x$/);
    const debug = createLogger("debug", (l) => lines.push(l));
    debug.event("otlp", ["logs=3"], () => "events=[user_prompt]");
    expect(lines[1]).toEndWith("logs=3  events=[user_prompt]");
    expect(shortPath(`${process.env.HOME}/Code/x`)).toBe("~/Code/x");
  });
});
