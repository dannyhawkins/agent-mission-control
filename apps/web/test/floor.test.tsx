import { afterEach, describe, expect, jest, test } from "bun:test";
import type { Decision, Session } from "@amc/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Floor } from "../src/components/Floor";

const at = new Date(0).toISOString();

function session(id: string, name: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    persona: {
      sessionId: id,
      name,
      spriteSeed: id.length * 7,
      color: "amber",
      voice: "deadpan",
      tagline: `${name} tagline`,
    },
    status: "working",
    cwd: `/tmp/${id}`,
    project: id,
    startedAt: at,
    lastSeenAt: at,
    statusLine: "",
    stats: { toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, decisionsAnswered: 0 },
    crew: [],
    ...extra,
  };
}

function decision(id: string, sessionId: string): Decision {
  return {
    id,
    sessionId,
    source: "mcp",
    question: `Question ${id}?`,
    options: [{ label: "Yes" }, { label: "No" }],
    urgency: "normal",
    status: "pending",
    createdAt: at,
    allowFreeText: false,
  };
}

const noop = async () => {};

function floor(sessions: Session[], decisions: Decision[], hotkeyDecisionId?: string) {
  return (
    <Floor
      sessions={sessions}
      decisions={decisions}
      activity={{}}
      recent={{}}
      hotkeyDecisionId={hotkeyDecisionId}
      now={Date.parse(at) + 1000}
      onAnswer={noop}
      onDismiss={noop}
      onTransmitted={() => {}}
      onMessage={noop}
    />
  );
}

// Not getAllByRole: hidden (unfocused) stations drop out of the accessibility tree.
const station = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("article.station")].find((a) =>
    a.getAttribute("aria-label")?.startsWith(name),
  );

const focusStrip = () => screen.queryByRole("navigation", { name: "Other stations" });

afterEach(() => {
  jest.useRealTimers();
});

describe("Floor", () => {
  test("no live sessions shows the quiet floor and lists ended ones off shift", () => {
    render(floor([session("gone", "GHOST", { status: "offline" })], []));
    expect(screen.getByText("NO OPERATORS ON SHIFT")).toBeDefined();
    expect(screen.getByText("OFF SHIFT 1")).toBeDefined();
    expect(screen.getByText("GHOST")).toBeDefined();
  });

  test("clicking a station head enters focus mode; the others become mini tiles", () => {
    const sessions = [session("a", "NOVA"), session("b", "RASCAL"), session("c", "PEPPER")];
    const { container } = render(floor(sessions, []));
    expect(container.querySelector(".floor")?.getAttribute("data-count")).toBe("3");
    expect(focusStrip()).toBeNull();

    fireEvent.click(station("NOVA")?.querySelector("header") as HTMLElement);

    const strip = focusStrip();
    expect(strip).not.toBeNull();
    const tiles = [...(strip?.querySelectorAll("button.mini:not(.mini--back)") ?? [])];
    expect(tiles.map((t) => t.querySelector(".mini__name")?.textContent)).toEqual([
      "RASCAL",
      "PEPPER",
    ]);
    expect(container.querySelector(".floor")?.getAttribute("data-count")).toBe("1");
    expect(station("NOVA")?.hidden).toBe(false);
    expect(station("NOVA")?.hasAttribute("data-focused")).toBe(true);
    // Unfocused stations stay mounted but hidden so drafts survive.
    expect(station("RASCAL")?.hidden).toBe(true);
  });

  test("a mini tile switches focus, ALL and Escape return to the grid", () => {
    render(floor([session("a", "NOVA"), session("b", "RASCAL")], []));
    fireEvent.click(station("NOVA")?.querySelector("header") as HTMLElement);

    fireEvent.click(screen.getByTitle("Focus RASCAL (b)"));
    expect(station("RASCAL")?.hidden).toBe(false);
    expect(station("NOVA")?.hidden).toBe(true);

    fireEvent.click(screen.getByText("ALL"));
    expect(focusStrip()).toBeNull();
    expect(station("NOVA")?.hidden).toBe(false);

    fireEvent.click(station("NOVA")?.querySelector("header") as HTMLElement);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(focusStrip()).toBeNull();
  });

  test("clicking the focused head again toggles focus off", () => {
    render(floor([session("a", "NOVA"), session("b", "RASCAL")], []));
    const head = () => station("NOVA")?.querySelector("header") as HTMLElement;
    fireEvent.click(head());
    expect(focusStrip()).not.toBeNull();
    fireEvent.click(head());
    expect(focusStrip()).toBeNull();
  });

  test("F focuses the station whose card owns the hotkeys; mini tile shows its wait", () => {
    const sessions = [session("a", "NOVA"), session("b", "RASCAL")];
    const decisions = [decision("d1", "b"), decision("d2", "a")];
    render(floor(sessions, decisions, "d1"));

    fireEvent.keyDown(window, { key: "f" });
    expect(station("RASCAL")?.hasAttribute("data-focused")).toBe(true);
    const tile = screen.getByTitle("Focus NOVA (a)");
    expect(tile.querySelector(".mini__badge")?.textContent).toBeTruthy();
    expect(tile.querySelector(".mini__wait")).not.toBeNull();
  });

  test("F with a modifier or with nothing waiting does nothing", () => {
    const { rerender } = render(floor([session("a", "NOVA")], [decision("d1", "a")], "d1"));
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(station("NOVA")?.hasAttribute("data-focused")).toBe(false);

    rerender(floor([session("a", "NOVA")], []));
    fireEvent.keyDown(window, { key: "f" });
    expect(station("NOVA")?.hasAttribute("data-focused")).toBe(false);
  });

  test("focus drops when the focused session leaves the floor", () => {
    const a = session("a", "NOVA");
    const b = session("b", "RASCAL");
    const { rerender } = render(floor([a, b], []));
    fireEvent.click(station("NOVA")?.querySelector("header") as HTMLElement);
    expect(focusStrip()).not.toBeNull();

    rerender(floor([{ ...a, status: "offline" }, b], []));
    expect(focusStrip()).toBeNull();
    expect(station("RASCAL")?.hidden).toBe(false);
  });

  test("answering the last card auto-returns to the grid when someone else is waiting", () => {
    jest.useFakeTimers();
    const sessions = [session("a", "NOVA"), session("b", "RASCAL")];
    const { rerender } = render(floor(sessions, [decision("d1", "a"), decision("d2", "b")], "d1"));
    fireEvent.keyDown(window, { key: "f" });
    expect(station("NOVA")?.hasAttribute("data-focused")).toBe(true);

    rerender(floor(sessions, [decision("d2", "b")], "d2"));
    // Lingers so the TRANSMITTED stamp can land.
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(focusStrip()).not.toBeNull();
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(focusStrip()).toBeNull();
  });

  test("stays focused after the last card when nobody else is waiting", () => {
    jest.useFakeTimers();
    const sessions = [session("a", "NOVA"), session("b", "RASCAL")];
    const { rerender } = render(floor(sessions, [decision("d1", "a")], "d1"));
    fireEvent.keyDown(window, { key: "F" });
    expect(focusStrip()).not.toBeNull();

    rerender(floor(sessions, [], undefined));
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(focusStrip()).not.toBeNull();
    expect(station("NOVA")?.hasAttribute("data-focused")).toBe(true);
  });
});
