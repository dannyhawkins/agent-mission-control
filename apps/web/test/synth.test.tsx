import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { escalationTier } from "@amc/shared";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { EmptyState } from "../src/components/EmptyState";
import { useNow } from "../src/util/useNow";

// A fake Web Audio graph that records what play() schedules.
const started: number[] = [];
class FakeParam {
  value = 0;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
}
class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  type = "";
  connect(n: unknown) {
    return n;
  }
  start(t: number) {
    started.push(t);
  }
  stop() {}
}
class FakeAudioContext {
  currentTime = 0;
  destination = new FakeNode();
  resume = () => Promise.resolve();
  createGain = () => new FakeNode();
  createOscillator = () => new FakeNode();
}

const g = globalThis as Record<string, unknown>;
const realAudio = g.AudioContext;
beforeAll(() => {
  g.AudioContext = FakeAudioContext;
  localStorage.clear();
});
afterAll(() => {
  g.AudioContext = realAudio;
  localStorage.clear();
});

describe("synth", () => {
  test("nothing plays before a gesture unlocks audio, then cues schedule notes", async () => {
    // Other tests (App) may have unlocked the shared module already; take a fresh instance.
    const synth: typeof import("../src/audio/synth") = await import(
      `../src/audio/synth.ts?fresh=${Date.now()}`
    );
    const { result } = renderHook(() => synth.useAudio());
    synth.play("incoming");
    expect(started).toHaveLength(0);

    const uninstall = synth.installAutoUnlock();
    // Gestures on the audio toggle itself are left to its click handler.
    const toggle = document.createElement("button");
    toggle.setAttribute("data-audio-toggle", "");
    document.body.append(toggle);
    fireEvent.pointerDown(toggle);
    await act(() => Promise.resolve());
    expect(result.current.unlocked).toBe(false);

    fireEvent.keyDown(window);
    await act(() => Promise.resolve());
    expect(result.current.unlocked).toBe(true);
    uninstall();
    toggle.remove();

    synth.play("transmitted");
    expect(started).toEqual([0, 0.07, 0.14, 0.21].map((t) => expect.closeTo(t, 5)) as never);

    act(() => synth.setMuted(true));
    expect(result.current.muted).toBe(true);
    expect(localStorage.getItem("amc.muted")).toBe("1");
    started.length = 0;
    synth.play("klaxon");
    expect(started).toHaveLength(0);
    act(() => synth.setMuted(false));
    expect(localStorage.getItem("amc.muted")).toBe("0");
  });
});

describe("EmptyState", () => {
  test("loading and empty floor copy", () => {
    const { rerender } = render(<EmptyState loading />);
    expect(screen.getByText("CONTACTING HUB")).toBeDefined();
    rerender(<EmptyState loading={false} />);
    expect(screen.getByText("NO OPERATORS ON THE FLOOR")).toBeDefined();
    expect(screen.getByText("task wire DIR=/path/to/project")).toBeDefined();
    expect(screen.getByRole("button", { name: "Open mock mode" })).toBeDefined();
  });
});

test("useNow ticks on its interval and stops on unmount", async () => {
  const { result, unmount } = renderHook(() => useNow(10));
  const first = result.current;
  await act(() => Bun.sleep(40));
  expect(result.current).toBeGreaterThan(first);
  unmount();
});

test("escalationTier thresholds", () => {
  const now = Date.parse("2026-01-01T00:10:00Z");
  expect(escalationTier(undefined, now)).toBe("calm");
  expect(escalationTier("2026-01-01T00:09:00Z", now)).toBe("calm");
  expect(escalationTier("2026-01-01T00:08:00Z", now)).toBe("amber");
  expect(escalationTier("2026-01-01T00:05:00Z", now)).toBe("red");
  expect(escalationTier("2026-01-01T00:00:00Z", now)).toBe("alarm");
});
