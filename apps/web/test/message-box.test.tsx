// The hub status -> MessageError mapping (409 unreachable, 429 rate_limited) is tested in
// use-hub.test.tsx; here the box is fed those errors and must show them to the user.
import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MessageBox } from "../src/components/MessageBox";
import { MessageError } from "../src/hub/errors";

const box = () => screen.getByLabelText("Message NOVA") as HTMLTextAreaElement;

function type(text: string) {
  fireEvent.change(box(), { target: { value: text } });
}

describe("MessageBox", () => {
  test("Enter sends the trimmed text, clears the box and flashes TRANSMITTED", async () => {
    const onSend = mock(async (_: string) => {});
    render(<MessageBox sessionName="NOVA" onSend={onSend} />);
    type("  new topic please  ");
    fireEvent.keyDown(box(), { key: "Enter" });

    await waitFor(() => expect(box().value).toBe(""));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toBe("new topic please");
    expect(screen.getByRole("status").textContent).toBe("TRANSMITTED");
  });

  test("Shift+Enter does not send (the textarea keeps its newline)", () => {
    const onSend = mock(async (_: string) => {});
    render(<MessageBox sessionName="NOVA" onSend={onSend} />);
    type("line one");
    const ev = fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    // fireEvent returns false only when the handler called preventDefault.
    expect(ev).toBe(true);
    type("line one\nline two");
    expect(onSend).not.toHaveBeenCalled();
    expect(box().value).toBe("line one\nline two");
  });

  test("blank text never sends", () => {
    const onSend = mock(async (_: string) => {});
    render(<MessageBox sessionName="NOVA" onSend={onSend} />);
    type("   ");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  test("an unreachable session (hub 409) shows a plain message and keeps the draft", async () => {
    const onSend = async () => {
      throw new MessageError("unreachable", "hub said 409 no_socket");
    };
    render(<MessageBox sessionName="NOVA" onSend={onSend} />);
    type("hello");
    fireEvent.keyDown(box(), { key: "Enter" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Couldn't reach the session.");
    expect(box().value).toBe("hello");
    expect(box().disabled).toBe(false);

    // Editing clears the error.
    type("hello again");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("rate limited (hub 429) shows the hub's slow-down message", async () => {
    const onSend = async () => {
      throw new MessageError("rate_limited", "Slow down: one message every 2 seconds.");
    };
    render(<MessageBox sessionName="NOVA" onSend={onSend} />);
    type("again");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Slow down: one message every 2 seconds.",
    );
  });

  test("a non-Error rejection falls back to a generic message", async () => {
    const onSend = () => Promise.reject("nope");
    render(<MessageBox sessionName="NOVA" onSend={onSend} />);
    type("x");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toBe("Send failed");
  });

  test("the box is disabled while a send is in flight", async () => {
    let release = () => {};
    const onSend = mock(() => new Promise<void>((r) => (release = r)));
    render(<MessageBox sessionName="NOVA" onSend={onSend} />);
    type("slow");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(box().disabled).toBe(true));
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await waitFor(() => expect(box().disabled).toBe(false));
  });
});
