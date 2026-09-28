import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { ServerEvent, StateSnapshot } from "@amc/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { AnswerError, MessageError } from "../src/hub/errors";
import { useHub, wantsMock } from "../src/hub/useHub";
import { decision, session, T0 } from "./hub-fixtures";

/** Stands in for the browser WebSocket: records instances so tests can drive open/message/close. */
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  close() {
    this.closed = true;
  }
  push(ev: ServerEvent | string) {
    this.onmessage?.({ data: typeof ev === "string" ? ev : JSON.stringify(ev) });
  }
}

interface Call {
  url: string;
  init?: RequestInit;
}

const g = globalThis as Record<string, unknown>;
const realFetch = g.fetch;
const realWs = g.WebSocket;
let calls: Call[] = [];
let respond: (url: string, init?: RequestInit) => Response;

const snap: StateSnapshot = {
  sessions: [session("b", { startedAt: "2026-09-25T10:01:00.000Z" }), session("a")],
  decisions: [
    decision("low", "a", { urgency: "low" }),
    decision("crit", "b", { urgency: "critical" }),
    decision("norm-late", "a", { createdAt: "2026-09-25T10:09:00.000Z" }),
    decision("norm-early", "a", { createdAt: "2026-09-25T10:01:00.000Z" }),
  ],
  log: [],
  serverTime: T0,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  FakeSocket.all = [];
  calls = [];
  respond = (url) => (url === "/api/state" ? json(snap) : json({ ok: true }));
  g.WebSocket = FakeSocket;
  g.fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  window.happyDOM.setURL("http://127.0.0.1:4242/");
});

afterEach(() => {
  g.fetch = realFetch;
  g.WebSocket = realWs;
  jest.useRealTimers();
});

async function connected() {
  const hook = renderHook(() => useHub());
  const ws = FakeSocket.all[0];
  if (!ws) throw new Error("no socket");
  expect(ws.url).toBe("ws://127.0.0.1:4242/ws");
  expect(hook.result.current.connection).toBe("connecting");
  act(() => ws.onopen?.());
  await waitFor(() => expect(hook.result.current.hydrated).toBe(true));
  return { hook, ws };
}

describe("useHub against the hub", () => {
  test("wantsMock reads ?mock=1", () => {
    expect(wantsMock()).toBe(false);
    window.happyDOM.setURL("http://127.0.0.1:4242/?mock=1");
    expect(wantsMock()).toBe(true);
  });

  test("open loads a snapshot; sessions sort by start, decisions by urgency then age", async () => {
    const { hook } = await connected();
    const h = hook.result.current;
    expect(h.connection).toBe("connected");
    expect(h.snapshots).toBe(1);
    expect(h.sessions.map((s) => s.id)).toEqual(["a", "b"]);
    expect(h.decisions.map((d) => d.id)).toEqual(["crit", "norm-early", "norm-late", "low"]);
    expect(calls[0]?.url).toBe("/api/state");
    hook.unmount();
  });

  test("pushed events apply; malformed frames are ignored", async () => {
    const { hook, ws } = await connected();
    act(() => {
      ws.push("{not json");
      ws.push({ type: "session_removed", sessionId: "b" });
    });
    expect(hook.result.current.sessions.map((s) => s.id)).toEqual(["a"]);
    expect(hook.result.current.decisions.map((d) => d.id)).not.toContain("crit");
    hook.unmount();
  });

  test("close reconnects with backoff and resyncs on the next open", async () => {
    jest.useFakeTimers();
    const hook = renderHook(() => useHub());
    const first = FakeSocket.all[0];
    act(() => first?.onclose?.());
    expect(hook.result.current.connection).toBe("reconnecting");
    act(() => jest.advanceTimersByTime(999));
    expect(FakeSocket.all).toHaveLength(1);
    act(() => jest.advanceTimersByTime(1));
    expect(FakeSocket.all).toHaveLength(2);
    // Second failure waits twice as long.
    act(() => FakeSocket.all[1]?.onclose?.());
    act(() => jest.advanceTimersByTime(1999));
    expect(FakeSocket.all).toHaveLength(2);
    act(() => jest.advanceTimersByTime(1));
    expect(FakeSocket.all).toHaveLength(3);
    hook.unmount();
    expect(FakeSocket.all[2]?.closed).toBe(true);
    // No reconnect is scheduled after unmount.
    act(() => jest.advanceTimersByTime(60_000));
    expect(FakeSocket.all).toHaveLength(3);
  });

  test("answer posts the body and removes the card optimistically", async () => {
    const { hook } = await connected();
    const d = hook.result.current.decisions.find((x) => x.id === "crit");
    if (!d) throw new Error("missing");
    await act(() => hook.result.current.answer(d, { answer: "Yes", note: "go" }));
    const post = calls.at(-1);
    expect(post?.url).toBe("/api/decisions/crit/answer");
    expect(post?.init?.method).toBe("POST");
    expect(JSON.parse(String(post?.init?.body))).toEqual({ answer: "Yes", note: "go" });
    expect(hook.result.current.decisions.map((x) => x.id)).not.toContain("crit");
    hook.unmount();
  });

  test("answer maps 409 not_waiting to AnswerError and retires the card", async () => {
    const { hook } = await connected();
    respond = () => json({ reason: "not_waiting" }, 409);
    const d = hook.result.current.decisions[0];
    if (!d) throw new Error("missing");
    let err: unknown;
    await act(async () => {
      err = await hook.result.current.answer(d, { answer: "x" }).catch((e) => e);
    });
    expect(err).toBeInstanceOf(AnswerError);
    expect((err as AnswerError).kind).toBe("not_waiting");
    expect(hook.result.current.decisions.map((x) => x.id)).not.toContain(d.id);
    hook.unmount();
  });

  test("answer maps 409 not_answerable and 502 to undeliverable, other failures to Error", async () => {
    const { hook } = await connected();
    const d = hook.result.current.decisions[0];
    if (!d) throw new Error("missing");
    const attempt = async () => {
      let err: unknown;
      await act(async () => {
        err = await hook.result.current.answer(d, { answer: "x" }).catch((e) => e);
      });
      return err as Error;
    };
    respond = () => json({ reason: "not_answerable" }, 409);
    expect((await attempt()) as AnswerError).toMatchObject({ kind: "undeliverable" });
    respond = () => json({}, 502);
    expect((await attempt()) as AnswerError).toMatchObject({
      kind: "undeliverable",
      message: "Couldn't deliver, answer in the terminal.",
    });
    respond = () => json({}, 500);
    const e = await attempt();
    expect(e).not.toBeInstanceOf(AnswerError);
    expect(e.message).toBe("Transmit failed (500)");
    // Failures leave the card in place.
    expect(hook.result.current.decisions.map((x) => x.id)).toContain(d.id);
    hook.unmount();
  });

  test("dismiss is optimistic and restores the card when the hub refuses", async () => {
    const { hook } = await connected();
    const d = hook.result.current.decisions[0];
    if (!d) throw new Error("missing");
    await act(() => hook.result.current.dismiss(d));
    expect(calls.at(-1)?.url).toBe(`/api/decisions/${d.id}/cancel`);
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({ dismiss: true });
    expect(hook.result.current.decisions.map((x) => x.id)).not.toContain(d.id);

    const other = hook.result.current.decisions[0];
    if (!other) throw new Error("missing");
    respond = () => json({}, 500);
    let err: unknown;
    await act(async () => {
      err = await hook.result.current.dismiss(other).catch((e) => e);
    });
    expect((err as Error).message).toBe("Dismiss failed (500)");
    expect(hook.result.current.decisions.map((x) => x.id)).toContain(other.id);
    hook.unmount();
  });

  test("sendMessage posts text and maps failures to MessageError kinds", async () => {
    const { hook } = await connected();
    await act(() => hook.result.current.sendMessage("a b", "hello"));
    expect(calls.at(-1)?.url).toBe("/api/sessions/a%20b/message");
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({ text: "hello" });

    const kindFor = async (status: number) => {
      respond = () => json({}, status);
      const e = await hook.result.current.sendMessage("a", "x").catch((err) => err);
      expect(e).toBeInstanceOf(MessageError);
      return (e as MessageError).kind;
    };
    expect(await kindFor(409)).toBe("unreachable");
    expect(await kindFor(502)).toBe("unreachable");
    expect(await kindFor(429)).toBe("rate_limited");
    expect(await kindFor(500)).toBe("other");
    hook.unmount();
  });
});

describe("useHub in mock mode", () => {
  test("?mock=1 runs the simulator instead of opening a socket", async () => {
    jest.useFakeTimers();
    window.happyDOM.setURL("http://127.0.0.1:4242/?mock=1");
    const hook = renderHook(() => useHub());
    expect(FakeSocket.all).toHaveLength(0);
    expect(hook.result.current.connection).toBe("mock");
    expect(hook.result.current.hydrated).toBe(true);
    expect(hook.result.current.sessions.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);

    // Answers route to the simulator, not the network.
    const d = hook.result.current.decisions.find((x) => x.source === "mcp");
    if (!d) throw new Error("mock seeds an mcp card");
    let done = false;
    act(() => {
      hook.result.current.answer(d, { answer: d.options[0]?.label ?? "ok" }).then(() => {
        done = true;
      });
    });
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(done).toBe(true);
    expect(hook.result.current.decisions.map((x) => x.id)).not.toContain(d.id);
    expect(calls).toHaveLength(0);
    hook.unmount();
  });
});
