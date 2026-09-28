import type { Database } from "bun:sqlite";
import type {
  AskQuestion,
  Decision,
  DecisionRequest,
  DecisionStatus,
  DecisionWaitResponse,
  ServerEvent,
} from "@amc/shared";
import { type Answers, canonicalPlanAnswer, normalizeAnswers, summariseAnswers } from "./gate";

type Waiter = (r: DecisionWaitResponse) => void;

export class DecisionStore {
  private all = new Map<string, Decision>();
  private waiters = new Map<string, Set<Waiter>>();

  constructor(
    private db: Database,
    private emit: (ev: ServerEvent) => void,
    /** Fired after any status change so the session store can re-derive status. */
    private onChange: (decision: Decision, previous: DecisionStatus | undefined) => void,
  ) {
    // Pending decisions survive a hub restart: the MCP server keeps polling by id.
    // Settled ones are fetched lazily from the db by get().
    const rows = this.db
      .query<{ json: string }, []>("SELECT json FROM decisions WHERE status = 'pending'")
      .all();
    for (const r of rows) {
      const d = JSON.parse(r.json) as Decision;
      // Pending mcp decisions from before "typed answers always allowed" get it too.
      if (d.source === "mcp") d.allowFreeText = true;
      this.all.set(d.id, d);
    }
  }

  /**
   * Settled decisions are only kept in memory for the process lifetime, but the
   * MCP server may still be polling an id that was answered just before a hub
   * restart. Fall back to the db so the answer is never orphaned.
   */
  get(id: string): Decision | undefined {
    const cached = this.all.get(id);
    if (cached) return cached;
    const row = this.db
      .query<{ json: string }, [string]>("SELECT json FROM decisions WHERE id = ?")
      .get(id);
    if (!row) return undefined;
    const d = JSON.parse(row.json) as Decision;
    this.all.set(d.id, d);
    return d;
  }

  pending(): Decision[] {
    return [...this.all.values()].filter((d) => d.status === "pending");
  }

  pendingFor(sessionId: string): Decision[] {
    return this.pending().filter((d) => d.sessionId === sessionId);
  }

  create(
    req: DecisionRequest & {
      sessionId: string;
      agentId?: string;
      agentRole?: string;
      /** Gate-only: AskUserQuestion's questions / ExitPlanMode's plan. */
      questions?: AskQuestion[];
      plan?: string;
      prose?: { questions: string[]; message: string };
      recentContext?: { lastPrompt?: string; assistantText?: string };
      changePreview?: { filePath: string; diff: string; truncated: boolean };
      answerable?: boolean;
    },
  ): Decision {
    const decision: Decision = {
      id: crypto.randomUUID(),
      sessionId: req.sessionId,
      source: req.source,
      question: req.question,
      options: req.options ?? [],
      ...(req.context ? { context: req.context } : {}),
      urgency: req.urgency ?? "normal",
      status: "pending",
      createdAt: new Date().toISOString(),
      allowFreeText: req.allowFreeText ?? false,
      ...(req.toolName ? { toolName: req.toolName } : {}),
      ...(req.toolInput !== undefined ? { toolInput: req.toolInput } : {}),
      ...(req.questions ? { questions: req.questions } : {}),
      ...(req.plan !== undefined ? { plan: req.plan } : {}),
      ...(req.prose ? { prose: req.prose } : {}),
      ...(req.recentContext ? { recentContext: req.recentContext } : {}),
      ...(req.changePreview ? { changePreview: req.changePreview } : {}),
      ...(req.answerable !== undefined ? { answerable: req.answerable } : {}),
      ...(req.agentId ? { agentId: req.agentId } : {}),
      ...(req.agentRole ? { agentRole: req.agentRole } : {}),
    };
    this.all.set(decision.id, decision);
    this.persist(decision);
    this.emit({ type: "decision", decision });
    this.onChange(decision, undefined);
    return decision;
  }

  /**
   * Long-poll. Resolves immediately if already settled, otherwise when answered
   * or after `timeoutMs` with { status: "pending" } so the caller loops. We use
   * long-poll rather than a WebSocket on the MCP side because it is one fetch
   * with no reconnect logic and survives hub restarts (the id is the state).
   */
  wait(id: string, timeoutMs: number): Promise<DecisionWaitResponse> {
    const d = this.get(id);
    if (!d) return Promise.resolve({ status: "cancelled" });
    if (d.status !== "pending") return Promise.resolve(toWaitResponse(d));
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set<Waiter>();
      this.waiters.set(id, set);
      const timer = setTimeout(() => {
        set.delete(waiter);
        resolve({ status: "pending" });
      }, timeoutMs);
      timer.unref?.();
      const waiter: Waiter = (r) => {
        clearTimeout(timer);
        resolve(r);
      };
      set.add(waiter);
    });
  }

  answer(
    id: string,
    answer: string,
    note?: string,
    answers?: Answers,
  ): { ok: true; decision: Decision } | { ok: false; error: string; code: number } {
    const d = this.get(id);
    if (!d) return { ok: false, error: "no such decision", code: 404 };
    if (d.status !== "pending")
      return { ok: false, error: `decision already ${d.status}`, code: 409 };
    if (d.source === "ask" && d.questions?.length) {
      const norm = normalizeAnswers(d.questions, answers, answer);
      if (!norm.ok) return { ok: false, error: norm.error, code: 400 };
      d.answers = norm.answers;
      d.answer = summariseAnswers(d.questions, norm.answers);
      if (note?.trim()) d.note = note.trim();
      this.settle(d, "answered");
      return { ok: true, decision: d };
    }
    const trimmed = (d.source === "plan" ? canonicalPlanAnswer(answer) : answer).trim();
    if (!trimmed) return { ok: false, error: "answer is required", code: 400 };
    const matched = d.options.find((o) => o.label === trimmed);
    if (!matched && !d.allowFreeText && d.source !== "mcp") {
      return { ok: false, error: "answer must match one of the option labels", code: 400 };
    }
    d.answer = matched?.label ?? trimmed;
    if (note?.trim()) d.note = note.trim();
    this.settle(d, "answered");
    return { ok: true, decision: d };
  }

  cancel(id: string): Decision | undefined {
    const d = this.get(id);
    if (d?.status !== "pending") return d;
    this.settle(d, "cancelled");
    return d;
  }

  expire(id: string): Decision | undefined {
    const d = this.get(id);
    if (d?.status !== "pending") return d;
    this.settle(d, "expired");
    return d;
  }

  expireForSession(sessionId: string) {
    for (const d of this.pendingFor(sessionId)) this.expire(d.id);
  }

  /** Provisional session merge. */
  reassign(fromSessionId: string, toSessionId: string) {
    for (const d of this.all.values()) {
      if (d.sessionId === fromSessionId) {
        d.sessionId = toSessionId;
        this.persist(d);
        if (d.status === "pending") this.emit({ type: "decision", decision: d });
      }
    }
    this.db.run("UPDATE decisions SET session_id = ? WHERE session_id = ?", [
      toSessionId,
      fromSessionId,
    ]);
  }

  private settle(d: Decision, status: Exclude<DecisionStatus, "pending">) {
    const previous = d.status;
    d.status = status;
    d.answeredAt = new Date().toISOString();
    this.persist(d);
    this.emit({ type: "decision", decision: d });
    const waiters = this.waiters.get(d.id);
    this.waiters.delete(d.id);
    const response = toWaitResponse(d);
    for (const w of waiters ?? []) w(response);
    this.onChange(d, previous);
  }

  /** Flip whether the UI may answer a pending decision (prose delivery failed). */
  setAnswerable(id: string, answerable: boolean) {
    const d = this.get(id);
    if (d?.status !== "pending" || d.answerable === answerable) return;
    d.answerable = answerable;
    this.persist(d);
    this.emit({ type: "decision", decision: d });
  }

  private persist(d: Decision) {
    this.db.run(
      "INSERT OR REPLACE INTO decisions (id, session_id, status, json, created_at) VALUES (?, ?, ?, ?, ?)",
      [d.id, d.sessionId, d.status, JSON.stringify(d), d.createdAt],
    );
  }
}

function toWaitResponse(d: Decision): DecisionWaitResponse {
  switch (d.status) {
    case "pending":
      return { status: "pending" };
    case "answered":
      return {
        status: "answered",
        answer: d.answer ?? "",
        ...(d.note ? { note: d.note } : {}),
        ...(d.answers ? { answers: d.answers } : {}),
      };
    case "expired":
    case "cancelled":
      return { status: d.status };
  }
}
