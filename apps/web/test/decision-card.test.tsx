import { describe, expect, mock, test } from "bun:test";
import type { Decision, DecisionAnswerBody } from "@amc/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DecisionCard } from "../src/components/DecisionCard";

const decision = (extra: Partial<Decision> = {}): Decision => ({
  id: "d1",
  sessionId: "s1",
  source: "mcp",
  question: "Which database?",
  options: [
    { label: "Postgres", recommended: true, description: "boring and good" },
    { label: "SQLite" },
  ],
  urgency: "normal",
  status: "pending",
  createdAt: new Date(0).toISOString(),
  allowFreeText: false,
  ...extra,
});

function setup(d: Decision, hotkeys = true) {
  const onAnswer = mock(async (_b: DecisionAnswerBody) => {});
  const onDismiss = mock(async () => {});
  const r = render(
    <DecisionCard decision={d} hotkeys={hotkeys} onAnswer={onAnswer} onDismiss={onDismiss} />,
  );
  return { ...r, onAnswer, onDismiss };
}

const sendButton = () => document.querySelector(".btn--send") as HTMLButtonElement;
const optionButton = (label: string) =>
  screen.getByText(label).closest("button") as HTMLButtonElement;

describe("DecisionCard (choice)", () => {
  test("renders the title, question, options and REC marker", () => {
    setup(decision({ question: "Use `bun` here?" }));
    expect(screen.getByText("INCOMING TRANSMISSION")).toBeTruthy();
    expect(screen.getByText("bun").tagName).toBe("CODE");
    expect(screen.getByText("REC")).toBeTruthy();
    expect(screen.getByText("boring and good")).toBeTruthy();
    expect(screen.getByText("KEYS 1-2")).toBeTruthy();
  });

  test("send is disabled until an option is picked, then sends its label and note", async () => {
    const { onAnswer } = setup(decision());
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(optionButton("SQLite"));
    expect(optionButton("SQLite").getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByPlaceholderText("note to agent (optional)"), {
      target: { value: "  keep it small  " },
    });
    await act(async () => fireEvent.click(sendButton()));
    expect(onAnswer).toHaveBeenCalledWith({ answer: "SQLite", note: "keep it small" });
    expect(sendButton().textContent).toBe("Sending");
  });

  test("an empty note is omitted", async () => {
    const { onAnswer } = setup(decision());
    fireEvent.click(optionButton("Postgres"));
    await act(async () => fireEvent.click(sendButton()));
    expect(onAnswer.mock.calls[0]?.[0]).toEqual({ answer: "Postgres", note: undefined });
  });

  test("mcp decisions always take free text, which clears the picked option", async () => {
    const { onAnswer } = setup(decision());
    fireEvent.click(optionButton("Postgres"));
    fireEvent.change(screen.getByPlaceholderText("or type a different answer"), {
      target: { value: " MySQL " },
    });
    expect(optionButton("Postgres").getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(sendButton()));
    expect(onAnswer.mock.calls[0]?.[0].answer).toBe("MySQL");
  });

  test("permission decisions without allowFreeText have no free text field", () => {
    setup(decision({ source: "permission", toolName: "Bash", toolInput: { x: 1 } }));
    expect(screen.queryByPlaceholderText("or type a different answer")).toBeNull();
    expect(screen.getByText("PERMISSION REQUEST")).toBeTruthy();
    expect(screen.getByText("Details (Bash)")).toBeTruthy();
  });

  test("no options and no free text is informational only", () => {
    setup(decision({ source: "hook", options: [] }));
    expect(screen.getByText("Informational. No answer expected.")).toBeTruthy();
    expect(document.querySelector(".btn--send")).toBeNull();
  });

  test("number keys pick an option and Enter sends", async () => {
    const { onAnswer } = setup(decision());
    fireEvent.keyDown(window, { key: "2" });
    expect(optionButton("SQLite").getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(window, { key: "9" });
    expect(optionButton("SQLite").getAttribute("aria-pressed")).toBe("true");
    await act(async () => fireEvent.keyDown(window, { key: "Enter" }));
    expect(onAnswer).toHaveBeenCalledWith({ answer: "SQLite", note: undefined });
  });

  test("modifier keys and Shift+Enter are ignored", async () => {
    const { onAnswer } = setup(decision());
    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    expect(optionButton("Postgres").getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(window, { key: "1" });
    await act(async () => fireEvent.keyDown(window, { key: "Enter", shiftKey: true }));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  test("Enter in this card's own input sends, digits typed there do not pick", async () => {
    const { onAnswer } = setup(decision());
    const note = screen.getByPlaceholderText("note to agent (optional)");
    fireEvent.keyDown(note, { key: "1" });
    expect(optionButton("Postgres").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(optionButton("Postgres"));
    await act(async () => fireEvent.keyDown(note, { key: "Enter" }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  test("Enter typed in another card's input is left alone", async () => {
    const { onAnswer } = setup(decision());
    fireEvent.click(optionButton("Postgres"));
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    await act(async () => fireEvent.keyDown(elsewhere, { key: "Enter" }));
    expect(onAnswer).not.toHaveBeenCalled();
    elsewhere.remove();
  });

  test("without hotkeys the keyboard does nothing", () => {
    setup(decision(), false);
    expect(screen.queryByText("KEYS 1-2")).toBeNull();
    fireEvent.keyDown(window, { key: "1" });
    expect(optionButton("Postgres").getAttribute("aria-pressed")).toBe("false");
  });

  test("a failed send shows the error and re-enables the card", async () => {
    const onAnswer = mock(async () => {
      throw new Error("hub said no");
    });
    render(
      <DecisionCard decision={decision()} hotkeys onAnswer={onAnswer} onDismiss={async () => {}} />,
    );
    fireEvent.click(optionButton("Postgres"));
    await act(async () => fireEvent.click(sendButton()));
    expect(screen.getByRole("alert").textContent).toBe("hub said no");
    expect(sendButton().disabled).toBe(false);
  });
});

describe("DecisionCard (plan)", () => {
  test("a plan with no options gets the three gate labels, Approve recommended", async () => {
    const { onAnswer } = setup(
      decision({ source: "plan", options: [], plan: "# Steps\n- **one**\n- two" }),
    );
    expect(screen.getByText("PLAN APPROVAL")).toBeTruthy();
    const labels = [...document.querySelectorAll(".opt__label")].map((e) => e.textContent);
    expect(labels).toEqual(["Approve", "Approve + auto-accept edits", "Keep planning"]);
    expect(optionButton("Approve").hasAttribute("data-recommended")).toBe(true);
    expect(screen.getByText("Steps").className).toBe("card__plan-h");
    expect(document.querySelector(".card__plan")?.textContent).toContain("• one");

    fireEvent.keyDown(window, { key: "3" });
    fireEvent.change(screen.getByPlaceholderText("what to change (sent to Claude)"), {
      target: { value: "split step two" },
    });
    await act(async () => fireEvent.click(sendButton()));
    expect(onAnswer).toHaveBeenCalledWith({ answer: "Keep planning", note: "split step two" });
  });
});
