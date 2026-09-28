import { describe, expect, mock, test } from "bun:test";
import type { Decision, DecisionAnswerBody } from "@amc/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DecisionCard } from "../src/components/DecisionCard";
import { AnswerError } from "../src/hub/errors";

const decision = (extra: Partial<Decision> = {}): Decision => ({
  id: "p1",
  sessionId: "s1",
  source: "prose",
  question: "Should I also update the docs?",
  options: [],
  prose: {
    questions: ["Should I also update the docs?", "Keep the `v1` route?"],
    message: "Done with the refactor. Should I also update the docs?",
  },
  urgency: "normal",
  status: "pending",
  createdAt: new Date(0).toISOString(),
  allowFreeText: true,
  ...extra,
});

function setup(
  d: Decision,
  onAnswer = mock(async (_b: DecisionAnswerBody) => {}),
  onDismiss = mock(async () => {}),
) {
  render(<DecisionCard decision={d} hotkeys onAnswer={onAnswer} onDismiss={onDismiss} />);
  return { onAnswer, onDismiss };
}

const send = () => document.querySelector(".btn--send") as HTMLButtonElement;
const input = () => screen.getByPlaceholderText("reply (delivered to the session)");

describe("ProseCard", () => {
  test("lists the extracted questions and Claude's last message", () => {
    setup(decision());
    expect(screen.getByText("WAITING ON YOU")).toBeTruthy();
    expect(screen.getByText("1.")).toBeTruthy();
    expect(screen.getByText("2.")).toBeTruthy();
    expect(screen.getByText("v1").tagName).toBe("CODE");
    expect(screen.getByText("Claude's last message")).toBeTruthy();
  });

  test("without prose details the decision question is the only one", () => {
    setup(decision({ prose: undefined }));
    expect(screen.getByText("Should I also update the docs?")).toBeTruthy();
    expect(screen.queryByText("2.")).toBeNull();
    expect(screen.queryByText("Claude's last message")).toBeNull();
  });

  test("answerable: send is disabled until text, submits the trimmed reply", async () => {
    const { onAnswer } = setup(decision());
    expect(send().disabled).toBe(true);
    fireEvent.change(input(), { target: { value: "  yes, and keep v1  " } });
    expect(send().disabled).toBe(false);
    await act(async () => fireEvent.click(send()));
    expect(onAnswer).toHaveBeenCalledWith({ answer: "yes, and keep v1" });
    expect(screen.queryByText("Dismiss")).toBeNull();
  });

  test("a generic failure shows the error and keeps the reply form", async () => {
    setup(
      decision(),
      mock(async () => {
        throw new Error("boom");
      }),
    );
    fireEvent.change(input(), { target: { value: "yes" } });
    await act(async () => fireEvent.click(send()));
    expect(screen.getByRole("alert").textContent).toBe("boom");
    expect(send().disabled).toBe(false);
  });

  test("an undeliverable answer falls back to the terminal mode", async () => {
    const { onDismiss } = setup(
      decision(),
      mock(async () => {
        throw new AnswerError("undeliverable", "no route");
      }),
    );
    fireEvent.change(input(), { target: { value: "yes" } });
    await act(async () => fireEvent.click(send()));
    expect(screen.getByText("Couldn't deliver, answer in the terminal.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => fireEvent.click(screen.getByText("Dismiss")));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("terminal mode (answerable false) offers only Dismiss", async () => {
    const { onAnswer, onDismiss } = setup(decision({ answerable: false }));
    expect(screen.getByText("Answer in the terminal.")).toBeTruthy();
    expect(document.querySelector("input")).toBeNull();
    await act(async () => fireEvent.click(screen.getByText("Dismiss")));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onAnswer).not.toHaveBeenCalled();
    expect((screen.getByText("Dismiss") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a failed dismiss shows the error and re-enables the button", async () => {
    setup(
      decision({ answerable: false }),
      undefined,
      mock(async () => {
        throw new Error("already gone");
      }),
    );
    await act(async () => fireEvent.click(screen.getByText("Dismiss")));
    expect(screen.getByRole("alert").textContent).toBe("already gone");
    expect((screen.getByText("Dismiss") as HTMLButtonElement).disabled).toBe(false);
  });
});
