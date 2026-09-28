import { describe, expect, mock, test } from "bun:test";
import type { AskQuestion, Decision, DecisionAnswerBody } from "@amc/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DecisionCard } from "../src/components/DecisionCard";

// Keys must be the verbatim question text: Claude Code matches answers by it.
const LANG = "Which language should the `cli` use?";
const FEATURES = "Which features do you want?";

const questions: AskQuestion[] = [
  {
    question: LANG,
    header: "Language",
    multiSelect: false,
    options: [
      { label: "TypeScript", description: "same as the rest" },
      { label: "Go", preview: "package main" },
    ],
  },
  {
    question: FEATURES,
    header: "Features",
    multiSelect: true,
    options: [{ label: "Colors" }, { label: "JSON" }, { label: "Completion" }],
  },
];

const decision = (qs: AskQuestion[] = questions): Decision => ({
  id: "ask1",
  sessionId: "s1",
  source: "ask",
  question: qs[0]?.question ?? "",
  options: [],
  questions: qs,
  urgency: "high",
  status: "pending",
  createdAt: new Date(0).toISOString(),
  allowFreeText: true,
});

function setup(d = decision(), hotkeys = true) {
  const onAnswer = mock(async (_b: DecisionAnswerBody) => {});
  render(
    <DecisionCard decision={d} hotkeys={hotkeys} onAnswer={onAnswer} onDismiss={async () => {}} />,
  );
  return { onAnswer };
}

const send = () => document.querySelector(".btn--send") as HTMLButtonElement;
const opt = (label: string) => screen.getByText(label).closest("button") as HTMLButtonElement;
const other = (header: string) =>
  screen
    .getByText(`Other answer for ${header}`)
    .parentElement?.querySelector("input") as HTMLInputElement;
const progress = () => document.querySelector(".ask__progress")?.textContent;

describe("AskCard", () => {
  test("renders every question with its header, urgency and multi marker", () => {
    setup();
    expect(screen.getByText("QUESTIONS")).toBeTruthy();
    expect(screen.getByText("Language")).toBeTruthy();
    expect(screen.getByText("PICK ANY")).toBeTruthy();
    expect(screen.getByText("HIGH")).toBeTruthy();
    expect(screen.getByText("cli").tagName).toBe("CODE");
    expect(screen.getByText("KEYS 1-2 TAB")).toBeTruthy();
    expect(progress()).toBe("0/2 answered");
  });

  test("a single question is titled QUESTION", () => {
    setup(decision([questions[0] as AskQuestion]));
    expect(screen.getByText("QUESTION")).toBeTruthy();
  });

  test("send stays disabled until every question has an answer", () => {
    setup();
    expect(send().disabled).toBe(true);
    fireEvent.click(opt("Go"));
    expect(progress()).toBe("1/2 answered");
    expect(send().disabled).toBe(true);
    fireEvent.click(opt("JSON"));
    expect(send().disabled).toBe(false);
    // Unticking the only multi-select pick makes it incomplete again.
    fireEvent.click(opt("JSON"));
    expect(send().disabled).toBe(true);
  });

  test("single-select replaces the pick; multi-select toggles and keeps order of picking", async () => {
    const { onAnswer } = setup();
    fireEvent.click(opt("TypeScript"));
    fireEvent.click(opt("Go"));
    expect(opt("TypeScript").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(opt("Completion"));
    fireEvent.click(opt("Colors"));
    expect(opt("Colors").textContent).toContain("[x]");
    await act(async () => fireEvent.click(send()));
    expect(onAnswer).toHaveBeenCalledWith({
      answer: "Language: Go · Features: Completion, Colors",
      answers: { [LANG]: "Go", [FEATURES]: ["Completion", "Colors"] },
    });
  });

  test("other text replaces a single-select pick and is appended to multi-select picks", async () => {
    const { onAnswer } = setup();
    fireEvent.click(opt("Go"));
    fireEvent.change(other("Language"), { target: { value: "  Rust  " } });
    expect(opt("Go").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(opt("JSON"));
    fireEvent.change(other("Features"), { target: { value: "man page" } });
    await act(async () => fireEvent.click(send()));
    expect(onAnswer.mock.calls[0]?.[0].answers).toEqual({
      [LANG]: "Rust",
      [FEATURES]: ["JSON", "man page"],
    });
  });

  test("other text alone answers a multi-select question", () => {
    setup();
    fireEvent.click(opt("Go"));
    fireEvent.change(other("Features"), { target: { value: "plugins" } });
    expect(send().disabled).toBe(false);
  });

  test("picking a single option clears that question's other text", () => {
    setup();
    fireEvent.change(other("Language"), { target: { value: "Zig" } });
    fireEvent.click(opt("TypeScript"));
    expect(other("Language").value).toBe("");
  });

  test("number keys answer the active question, which advances to the next unanswered", async () => {
    const { onAnswer } = setup();
    fireEvent.keyDown(window, { key: "1" });
    expect(opt("TypeScript").getAttribute("aria-pressed")).toBe("true");
    // Active moved to Features (3 options, keys up to 3).
    expect(screen.getByText("KEYS 1-3 TAB")).toBeTruthy();
    fireEvent.keyDown(window, { key: "3" });
    fireEvent.keyDown(window, { key: "2" });
    await act(async () => fireEvent.keyDown(window, { key: "Enter" }));
    expect(onAnswer.mock.calls[0]?.[0].answers).toEqual({
      [LANG]: "TypeScript",
      [FEATURES]: ["Completion", "JSON"],
    });
  });

  test("Tab and Shift+Tab move between questions", () => {
    setup();
    fireEvent.keyDown(document.body, { key: "Tab" });
    fireEvent.keyDown(window, { key: "1" });
    expect(opt("Colors").getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true });
    fireEvent.keyDown(window, { key: "2" });
    expect(opt("Go").getAttribute("aria-pressed")).toBe("true");
  });

  test("Enter while incomplete does nothing; typing in an input does not pick", async () => {
    const { onAnswer } = setup();
    fireEvent.keyDown(other("Language"), { key: "1" });
    expect(opt("TypeScript").getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.keyDown(window, { key: "Enter" }));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  test("hovering an option with a preview shows it as plain text", () => {
    setup();
    fireEvent.mouseEnter(opt("Go"));
    expect(document.querySelector(".ask__preview")?.textContent).toBe("package main");
    fireEvent.mouseLeave(opt("Go"));
    expect(document.querySelector(".ask__preview")).toBeNull();
  });

  test("a failed send shows the error", async () => {
    const onAnswer = mock(async () => {
      throw new Error("gate closed");
    });
    render(
      <DecisionCard
        decision={decision([questions[0] as AskQuestion])}
        hotkeys={false}
        onAnswer={onAnswer}
        onDismiss={async () => {}}
      />,
    );
    fireEvent.click(opt("Go"));
    await act(async () => fireEvent.click(send()));
    expect(screen.getByRole("alert").textContent).toBe("gate closed");
    expect(send().disabled).toBe(false);
  });
});
