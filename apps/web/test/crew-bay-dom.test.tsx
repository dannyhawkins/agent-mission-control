import { describe, expect, test } from "bun:test";
import type { CrewMember } from "@amc/shared";
import { render, screen } from "@testing-library/react";
import { CrewBay } from "../src/components/CrewBay";

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

const items = () =>
  [...screen.getByRole("list", { name: "Crew" }).querySelectorAll<HTMLElement>("li.crew__m")].map(
    (li) => ({ label: li.querySelector(".crew__role")?.textContent, status: li.dataset.status }),
  );

describe("CrewBay in the DOM", () => {
  test("empty crew renders nothing", () => {
    const { container } = render(<CrewBay crew={[]} tint="#fff" />);
    expect(container.innerHTML).toBe("");
  });

  test("standby members sit dimmed after everyone on shift, before done", () => {
    render(
      <CrewBay
        tint="#fc0"
        crew={[
          member("sleepy", "standby"),
          member("gone", "done"),
          member("busy", "working"),
          member("asking", "waiting_decision"),
          member("nap", "standby"),
        ]}
      />,
    );
    expect(items()).toEqual([
      { label: "ASKING", status: "waiting_decision" },
      { label: "BUSY", status: "working" },
      // Spawn order kept within the standby group.
      { label: "SLEEPY", status: "standby" },
      { label: "NAP", status: "standby" },
      { label: "GONE", status: "done" },
    ]);
  });

  test("overflow collapses the tail (standby and done first) into +N, never a waiting member", () => {
    const crew = [
      ...Array.from({ length: 5 }, (_, i) => member(`s${i}`, "standby")),
      member("w1", "working"),
      member("ask", "waiting_decision"),
    ];
    render(<CrewBay tint="#fc0" crew={crew} />);
    const shown = items();
    expect(shown).toHaveLength(6);
    expect(shown[0]).toEqual({ label: "ASK", status: "waiting_decision" });
    expect(shown[1]?.status).toBe("working");
    const more = screen.getByText("+1");
    expect(more.getAttribute("title")).toBe("s4");
  });

  test("tooltip says why a member is dim, labels win over roles", () => {
    render(
      <CrewBay
        tint="#fc0"
        crew={[
          member("t1", "standby", { team: "alpha", lastTool: "Bash", label: "fix tests" }),
          member("c1", "working", { kind: "child_session", role: "child_session" }),
        ]}
      />,
    );
    const standby = screen.getByText("FIX TESTS").closest("li");
    expect(standby?.dataset.labelled).toBe("");
    const title = standby?.getAttribute("title") ?? "";
    expect(title.split("\n")).toEqual([
      "fix tests",
      "t1 (teammate)",
      "t1",
      "0 tool calls",
      "team alpha",
      "last tool Bash",
      "standby (between tasks)",
    ]);
    const child = screen.getAllByRole("listitem")[0];
    expect(child?.getAttribute("title")).toContain("(nested session)");
  });

  test("a done member's fade starts where it would be had we been watching", () => {
    const endedAt = new Date(Date.now() - 3000).toISOString();
    render(<CrewBay tint="#fc0" crew={[member("gone", "done", { endedAt })]} />);
    const li = screen.getByText("GONE").closest("li") as HTMLElement;
    const delay = Number.parseInt(li.style.animationDelay, 10);
    expect(delay).toBeLessThanOrEqual(-3000);
    expect(delay).toBeGreaterThan(-10_000);
    expect(li.getAttribute("title")).toContain("finished");
  });
});
