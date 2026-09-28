import type {
  Decision,
  DecisionAnswerBody,
  LogEntry,
  ServerEvent,
  Session,
  StateSnapshot,
} from "@amc/shared";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AnswerError, MessageError } from "./errors";
import { createMockHub, type MockHub } from "./mock";
import { type ActivityLine, initialState, reduce } from "./state";

export type Connection = "connecting" | "connected" | "reconnecting" | "mock";

export interface Hub {
  sessions: Session[];
  decisions: Decision[];
  log: LogEntry[];
  activity: Record<string, number>;
  recent: Record<string, ActivityLine[]>;
  connection: Connection;
  hydrated: boolean;
  /** Increments on each snapshot (load, reconnect); see HubState.snapshots. */
  snapshots: number;
  answer: (decision: Decision, body: DecisionAnswerBody) => Promise<void>;
  dismiss: (decision: Decision) => Promise<void>;
  /** Free-form message into a session (new topic, comment). Throws MessageError on failure. */
  sendMessage: (sessionId: string, text: string) => Promise<void>;
}

export function wantsMock(): boolean {
  return new URLSearchParams(location.search).get("mock") === "1";
}

const URGENCY_RANK = { critical: 0, high: 1, normal: 2, low: 3 } as const;

export function useHub(): Hub {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [connection, setConnection] = useState<Connection>(wantsMock() ? "mock" : "connecting");
  const mockRef = useRef<MockHub | null>(null);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let everOpened = false;

    const startMock = () => {
      if (mockRef.current) return;
      mockRef.current = createMockHub(dispatch);
      setConnection("mock");
    };

    const loadSnapshot = async () => {
      const res = await fetch("/api/state");
      if (!res.ok) throw new Error(`GET /api/state -> ${res.status}`);
      const snapshot = (await res.json()) as StateSnapshot;
      if (!disposed) dispatch({ type: "snapshot", state: snapshot });
    };

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        attempt = 0;
        everOpened = true;
        setConnection("connected");
        // Events pushed while we were away are gone for good; a fresh snapshot is the only safe merge.
        loadSnapshot().catch(() => {});
      };
      ws.onmessage = (m) => {
        try {
          dispatch(JSON.parse(String(m.data)) as ServerEvent);
        } catch {
          // Ignore malformed frames; the next snapshot will reconcile.
        }
      };
      ws.onclose = () => {
        if (disposed) return;
        // VITE_MOCK lets a dev run without the hub: fall back to the simulator if we never connected.
        if (!everOpened && import.meta.env.VITE_MOCK) {
          ws = null;
          startMock();
          return;
        }
        setConnection("reconnecting");
        const delay = Math.min(15_000, 1000 * 2 ** attempt++);
        retry = setTimeout(connect, delay);
      };
    };

    if (wantsMock()) startMock();
    else connect();

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      mockRef.current?.stop();
      mockRef.current = null;
    };
  }, []);

  const answer = useCallback(async (decision: Decision, body: DecisionAnswerBody) => {
    if (mockRef.current) {
      await mockRef.current.answer(decision.id, body);
      return;
    }
    const res = await fetch(`/api/decisions/${encodeURIComponent(decision.id)}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 409) {
      const reason = await res
        .json()
        .then((j: { reason?: string }) => j.reason)
        .catch(() => undefined);
      if (reason === "not_waiting") {
        dispatch({ type: "decision", decision: { ...decision, status: "cancelled" } });
        throw new AnswerError("not_waiting", "No longer waiting, answer in the terminal.");
      }
      // A prose card that lost its delivery route between render and Send.
      if (reason === "not_answerable") {
        throw new AnswerError("undeliverable", "Answer in the terminal.");
      }
    }
    if (res.status === 502) {
      throw new AnswerError("undeliverable", "Couldn't deliver, answer in the terminal.");
    }
    if (!res.ok) throw new Error(`Transmit failed (${res.status})`);
    // Optimistic removal; the hub's own "decision" push for the same id is then a no-op.
    dispatch({
      type: "decision",
      decision: {
        ...decision,
        status: "answered",
        answer: body.answer,
        note: body.note,
        ...(body.answers ? { answers: body.answers } : {}),
      },
    });
  }, []);

  // Optimistic: the card goes at once and comes back only if the hub refuses.
  const dismiss = useCallback(async (decision: Decision) => {
    dispatch({ type: "decision", decision: { ...decision, status: "cancelled" } });
    if (mockRef.current) {
      await mockRef.current.dismiss(decision.id);
      return;
    }
    // `dismiss` tells the hub a person retired the card (logged "Dismissed."), not the agent.
    const res = await fetch(`/api/decisions/${encodeURIComponent(decision.id)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dismiss: true }),
    });
    if (!res.ok) {
      dispatch({ type: "decision", decision });
      throw new Error(`Dismiss failed (${res.status})`);
    }
  }, []);

  const sendMessage = useCallback(async (sessionId: string, text: string) => {
    if (mockRef.current) {
      await mockRef.current.sendMessage(sessionId, text);
      return;
    }
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (res.status === 409 || res.status === 502) {
      throw new MessageError("unreachable", "Couldn't reach the session.");
    }
    if (res.status === 429) {
      throw new MessageError("rate_limited", "Slow down: one message every 2 seconds.");
    }
    if (!res.ok) throw new MessageError("other", `Send failed (${res.status})`);
  }, []);

  const sessions = useMemo(
    () => Object.values(state.sessions).sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    [state.sessions],
  );
  const decisions = useMemo(
    () =>
      Object.values(state.decisions).sort(
        (a, b) =>
          URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] ||
          a.createdAt.localeCompare(b.createdAt),
      ),
    [state.decisions],
  );

  return {
    sessions,
    decisions,
    log: state.log,
    activity: state.activity,
    recent: state.recent,
    connection,
    hydrated: state.hydrated,
    snapshots: state.snapshots,
    answer,
    dismiss,
    sendMessage,
  };
}
