import { describe, expect, mock, test } from "bun:test";
import type { Decision, Session } from "@amc/shared";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MissionLog } from "../src/components/MissionLog";
import { effectiveStatus, presented, Station } from "../src/components/Station";
import { AnswerError } from "../src/hub/errors";
import { decision, logEntry, session } from "./hub-fixtures";

const NOW = Date.parse("2026-09-25T10:00:00.000Z");

function renderStation(s: Session, decisions: Decision[] = [], extra = {}) {
  const props = {
    session: s,
    decisions,
    activityAt: undefined,
    recent: [],
    hotkeyDecisionId: undefined,
    now: NOW,
    onAnswer: mock(async () => {}),
    onDismiss: mock(async () => {}),
    onTransmitted: mock(() => {}),
    focused: false,
    hidden: false,
    onFocusToggle: mock(() => {}),
    onMessage: mock(async () => {}),
    ...extra,
  };
  return { ...render(<Station {...props} />), props };
}

describe("Station", () => {
  test("a pending card makes the station wait whatever the hub status says", () => {
    expect(effectiveStatus("idle", [decision("d", "a")])).toBe("waiting_decision");
    expect(effectiveStatus("working", [decision("d", "a", { source: "permission" })])).toBe(
      "waiting_permission",
    );
    expect(effectiveStatus("offline", [decision("d", "a")])).toBe("offline");
    expect(
      presented(session("a", { status: "idle" }), [decision("d", "a", { source: "prose" })]).label,
    ).toBe("WAITING: YOU");
  });

  test("standby text follows the status and whether it can be messaged", () => {
    const cases: [Partial<Session>, string][] = [
      [{ status: "working" }, "Working. Nothing needs you here."],
      [{ status: "idle" }, "Ready for the next prompt in the terminal."],
      [
        { status: "idle", canMessage: true },
        "Ready for the next prompt. Message it below or in the terminal.",
      ],
      [{ status: "offline" }, "Signal lost."],
      [
        { status: "waiting_permission" },
        "Permission prompt open in the terminal. Answer it there.",
      ],
      [{ status: "waiting_decision" }, "Awaiting a decision (not received yet)."],
    ];
    for (const [extra, text] of cases) {
      const { unmount } = renderStation(session("a", extra));
      expect(screen.getByText(text)).toBeDefined();
      unmount();
    }
  });

  test("a message box appears only for sessions that can be messaged", () => {
    const { unmount } = renderStation(session("a", { status: "idle" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    unmount();
    renderStation(session("a", { status: "idle", canMessage: true }));
    expect(screen.getAllByRole("textbox").length).toBeGreaterThan(0);
  });

  test("scrollback shows recent lines, tinting a crew role prefix", () => {
    const s = session("a", {
      crew: [
        {
          id: "ag1",
          kind: "subagent",
          role: "Explore",
          spriteSeed: 3,
          status: "working",
          startedAt: "2026-09-25T09:59:00.000Z",
          lastSeenAt: "2026-09-25T09:59:00.000Z",
          toolCalls: 1,
        },
      ],
    });
    renderStation(s, [], {
      recent: [
        { at: "2026-09-25T09:59:00.000Z", line: "Explore: Reading · src/a.ts" },
        { at: "2026-09-25T09:59:30.000Z", line: "✗ Bash failed · bun test" },
      ],
    });
    const list = screen.getByRole("list", { name: "Recent activity" });
    expect(within(list).getByText("src/a.ts").className).toBe("act__target");
    expect(list.querySelector(".ticker__role")?.textContent).toContain("Explore");
    expect(list.querySelector(".act__fail")).not.toBeNull();
  });

  test("Enter on the station and a click on its head toggle focus", () => {
    const { props } = renderStation(session("a"));
    const article = screen.getByRole("article");
    fireEvent.keyDown(article, { key: "Enter" });
    fireEvent.click(article.querySelector("header.head") as Element);
    expect(props.onFocusToggle).toHaveBeenCalledTimes(2);
  });

  test("a card that stopped waiting leaves a notice instead of a stamp", async () => {
    const d = decision("d1", "a", { options: [{ label: "Go" }] });
    const onAnswer = mock(async () => {
      throw new AnswerError("not_waiting", "No longer waiting, answer in the terminal.");
    });
    const { props } = renderStation(session("a", { status: "waiting_decision" }), [d], {
      onAnswer,
    });
    fireEvent.click(screen.getByRole("button", { name: /Go/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(screen.getByText("No longer waiting, answer in the terminal.")).toBeDefined(),
    );
    expect(screen.queryByText("TRANSMITTED")).toBeNull();
    expect(props.onTransmitted).not.toHaveBeenCalled();
  });

  test("waiting and idle timers and the model show in the footer", () => {
    const { unmount } = renderStation(
      session("a", {
        status: "waiting_decision",
        blockedSince: new Date(NOW - 6 * 60_000).toISOString(),
        model: "claude-opus-5-5",
      }),
      [decision("d1", "a", { createdAt: new Date(NOW - 6 * 60_000).toISOString() })],
    );
    expect(screen.getByText("opus-5-5")).toBeDefined();
    const wait = document.querySelector(".wait");
    expect(wait?.textContent).toBe("WAITING 06:00");
    expect(wait?.getAttribute("data-tier")).toBe("red");
    unmount();
    renderStation(
      session("a", { status: "idle", blockedSince: new Date(NOW - 90_000).toISOString() }),
    );
    expect(document.querySelector(".idle-for")?.textContent).toBe("IDLE 01:30");
  });
});

describe("MissionLog", () => {
  test("empty log says so and shows no average", () => {
    render(<MissionLog log={[]} />);
    expect(screen.getByText("Nothing logged yet.")).toBeDefined();
    expect(screen.getByText("--:--")).toBeDefined();
  });

  test("newest first; alerts filter; answers flatten, clip and average", () => {
    const today = new Date().toISOString();
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const long = "x".repeat(120);
    const log = [
      logEntry("req", { kind: "decision_requested", decisionId: "d1", at: earlier }),
      logEntry("ans", {
        kind: "decision_answered",
        decisionId: "d1",
        at: today,
        text: "Paired by id.",
        meta: { answers: { "Colour?": "Blue", "Toppings?": ["Cheese", "Ham"] } },
      }),
      logEntry("ans2", {
        kind: "decision_answered",
        at: today,
        text: "Long one.",
        meta: { answer: long, waitedMs: 30_000 },
      }),
      logEntry("idle", { kind: "idle", text: "Went quiet." }),
    ];
    render(<MissionLog log={log} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]?.getAttribute("data-kind")).toBe("idle");
    expect(screen.getByText("Blue · Cheese, Ham")).toBeDefined();
    const clipped = screen.getByTitle(long);
    expect(clipped.textContent).toHaveLength(90);
    expect(screen.getByText("ANSWERED TODAY").nextElementSibling?.textContent).toBe("2");
    // (60s paired + 30s waitedMs) / 2 = 45s.
    expect(screen.getByText("AVG RESPONSE").nextElementSibling?.textContent).toBe("00:45");

    fireEvent.click(screen.getByRole("tab", { name: "ALERTS" }));
    const alerts = screen.getAllByRole("listitem");
    expect(alerts).toHaveLength(1);
    expect(within(alerts[0] as HTMLElement).getByRole("img", { name: "alert" })).toBeDefined();
  });

  test("crew toggle persists, and survives storage that throws", () => {
    const log = [logEntry("c", { agentId: "ag1", agentRole: "Explore", text: "crew line" })];
    localStorage.setItem("amc.log.showCrew", "0");
    const { unmount } = render(<MissionLog log={log} />);
    expect(screen.queryByText("crew line")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "CREW" }));
    expect(screen.getByText("crew line")).toBeDefined();
    expect(localStorage.getItem("amc.log.showCrew")).toBe("1");
    unmount();

    const proto = Object.getPrototypeOf(localStorage);
    const { getItem, setItem } = proto;
    proto.getItem = () => {
      throw new Error("blocked");
    };
    proto.setItem = proto.getItem;
    try {
      render(<MissionLog log={log} />);
      expect(screen.getByText("crew line")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "CREW" }));
      expect(screen.queryByText("crew line")).toBeNull();
    } finally {
      proto.getItem = getItem;
      proto.setItem = setItem;
      localStorage.clear();
    }
  });
});
