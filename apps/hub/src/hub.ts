import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import type {
  Decision,
  DecisionAnswerBody,
  DecisionRequest,
  HookPayload,
  ServerEvent,
  StateSnapshot,
} from "@amc/shared";
import type { Server } from "bun";
import { ActivityStore } from "./activity";
import { type HubConfig, loadConfig } from "./config";
import { changePreview, recentContext } from "./context";
import type { AncestryResolver } from "./crew";
import { crewRole } from "./crew";
import { openDb } from "./db";
import { DecisionStore } from "./decisions";
import {
  ASK_TOOL,
  keepPlanningMessage,
  PLAN_APPROVE,
  PLAN_APPROVE_ACCEPT_EDITS,
  PLAN_KEEP,
  PLAN_TOOL,
  parseQuestions,
  permissionDenyMessage,
} from "./gate";
import { createGuard } from "./guard";
import { createLogger, type HubLogger } from "./hublog";
import { IgnoreList } from "./ignore";
import { LogStore } from "./log";
import { parseOtlpLogs, parseOtlpMetrics, SumTracker, usageFromMetrics } from "./otlp";
import { PersonaStore } from "./personas";
import { extractQuestions, lastAssistantText, NUDGE_REASON, PROSE_TAIL_CHARS } from "./prose";
import { createRouter } from "./router";
import { type HookMeta, SessionStore } from "./sessions";
import { deliverToSession, socketExists, wrapAnswer, wrapMessage } from "./socket";
import { Tts } from "./tts";
import { phrase } from "./voice";
import { Broadcaster, type WsData } from "./ws";

export interface Hub {
  config: HubConfig;
  db: Database;
  sessions: SessionStore;
  decisions: DecisionStore;
  log: LogStore;
  broadcaster: Broadcaster;
  logger: HubLogger;
  /** Optional ElevenLabs voice (tts.ts). */
  tts: Tts;
  /** Persona callsign for a session id, for log lines. */
  callsign(sessionId: string | undefined): string | undefined;
  snapshot(): StateSnapshot;
  handleHook(
    event: string,
    meta: HookMeta | undefined,
    payload: HookPayload,
  ): "ok" | "duplicate" | "ignored";
  /** Session on the ignore list (by id, or by cwd prefix, which also remembers the id). */
  isIgnored(sessionId: string | undefined, cwd: string | undefined): boolean;
  /** `signal` aborts when the hook's curl goes away; the card is then expired at once. */
  gate(
    meta: HookMeta | undefined,
    payload: HookPayload,
    signal?: AbortSignal,
  ): Promise<GateResponse>;
  /** Stop hook: reports the stop, nudges once about prose questions, else posts a prose card. */
  stopHook(meta: HookMeta | undefined, payload: HookPayload): StopResponse;
  /** Operator dismissed a card in the UI (logged as such, unlike an MCP-side cancel). */
  dismissDecision(id: string): Decision | undefined;
  requestDecision(req: DecisionRequest): Decision;
  answerDecision(
    id: string,
    body: DecisionAnswerBody,
  ): Promise<
    | ReturnType<DecisionStore["answer"]>
    | {
        ok: false;
        error: string;
        code: number;
        reason: "not_waiting" | "not_answerable" | "delivery_failed";
      }
  >;
  /** Operator's free message to a session, delivered over its messaging socket. */
  messageSession(
    id: string,
    text: string,
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        code: number;
        error: string;
        reason: "unknown_session" | "no_socket" | "rate_limited" | "delivery_failed";
      }
  >;
  /** Shutdown: answer every open gate hook with {} so terminals fall back at once. */
  releaseGates(): void;
  reportStatus(input: {
    ancestorPids?: number[];
    cwd?: string;
    line: string;
    sessionId?: string;
  }): string;
  ingestOtlpLogs(body: unknown): number;
  ingestOtlpMetrics(body: unknown): number;
  stop(): void;
}

export type GateResponse =
  | {
      hookSpecificOutput: {
        hookEventName: "PreToolUse";
        permissionDecision: "allow" | "deny" | "ask";
        permissionDecisionReason: string;
        updatedInput?: unknown;
      };
    }
  | {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest";
        decision: {
          behavior: "allow" | "deny";
          message?: string;
          updatedInput?: unknown;
          updatedPermissions?: unknown[];
        };
      };
    }
  /** PermissionRequest timeout: an empty body leaves the terminal prompt in place. */
  | Record<string, never>;

export type StopResponse = { decision: "block"; reason: string } | Record<string, never>;

/** Test seams; production uses the defaults. */
export interface HubDeps {
  ancestry?: AncestryResolver;
  crewGraceMs?: number;
}

export function createHub(config: HubConfig = loadConfig(), deps: HubDeps = {}): Hub {
  const db = openDb(config.dataDir);
  const logger = createLogger(config.logLevel);
  const ignore = new IgnoreList(config.ignoreCwd, logger);
  // Before the stores load, so rows from ignored cwds never reach the floor.
  const purged = ignore.purge(db);
  if (purged.sessions > 0) {
    logger.info(
      "ignored ",
      `purged ${purged.sessions} session(s), ${purged.log} log row(s), ${purged.decisions} decision(s) under ${config.ignoreCwd.join(", ")}`,
    );
  }
  const broadcaster = new Broadcaster();
  const activity = new ActivityStore(db);
  const emit = (ev: ServerEvent) => {
    // History rides on the event stream: every activity line is kept, and a
    // session's lines go with it.
    if (ev.type === "activity") activity.add(ev.sessionId, { at: ev.at, line: ev.line });
    else if (ev.type === "session_removed") activity.drop(ev.sessionId);
    broadcaster.broadcast(ev);
  };
  const log = new LogStore(db, emit);
  const personas = new PersonaStore(db);
  const tts = new Tts(db, config.tts, config.dataDir, logger);

  // sessions and decisions reference each other; closures resolve lazily.
  const decisions = new DecisionStore(db, emit, (decision, previous) => {
    // Any decision means the session is doing real work.
    if (previous === undefined) sessions.engage(decision.sessionId);
    const persona = sessions.persona(decision.sessionId);
    if (persona) {
      // meta.answer / meta.waitedMs feed the UI's answer chip and "avg response" score.
      const waitedMs =
        decision.answeredAt !== undefined
          ? Date.parse(decision.answeredAt) - Date.parse(decision.createdAt)
          : undefined;
      const meta = {
        source: decision.source,
        ...(decision.answer !== undefined ? { answer: decision.answer } : {}),
        ...(waitedMs !== undefined ? { waitedMs } : {}),
      };
      const say = (text: string) =>
        log.add(persona, kindFor(decision), text, {
          decisionId: decision.id,
          meta,
          ...(decision.agentId ? { agentId: decision.agentId } : {}),
          ...(decision.agentRole ? { agentRole: decision.agentRole } : {}),
        });
      logger.info(
        "decision",
        (previous === undefined ? "requested" : decision.status).padEnd(9),
        persona.name,
        decision.source,
        JSON.stringify(decision.status === "answered" ? decision.answer : decision.question),
      );
      if (previous === undefined) {
        const n = decision.questions?.length ?? 0;
        say(
          decision.source === "ask"
            ? n === 1
              ? `Asked a question: ${decision.question}`
              : `Asked ${n} questions.`
            : decision.source === "plan"
              ? "Wants plan approval."
              : decision.source === "prose"
                ? `Stopped with ${decision.prose?.questions.length ?? 0} open question(s) in chat.`
                : phrase(persona.voice, persona.name, {
                    kind: "decision_requested",
                    question: decision.question,
                  }),
        );
      } else if (decision.status === "answered") {
        sessions.bumpDecisionsAnswered(decision.sessionId);
        say(
          decision.source === "prose"
            ? "Answer delivered to the session."
            : decision.source === "ask"
              ? `Answered: ${decision.answer ?? ""}`
              : decision.source === "plan"
                ? decision.answer === PLAN_APPROVE
                  ? "Plan approved."
                  : decision.answer === PLAN_APPROVE_ACCEPT_EDITS
                    ? "Plan approved, edits auto-accepted."
                    : `Keep planning${decision.note ? `: ${decision.note}` : "."}`
                : phrase(persona.voice, persona.name, {
                    kind: "decision_answered",
                    answer: decision.answer ?? "",
                  }),
        );
      } else if (decision.status === "expired") {
        say(
          expireNotes.get(decision.id) ??
            phrase(persona.voice, persona.name, { kind: "decision_expired" }),
        );
      } else if (decision.status === "cancelled") {
        const dismissed = dismissing.delete(decision.id);
        say(
          dismissed
            ? "Dismissed."
            : decision.source === "ask" ||
                decision.source === "plan" ||
                decision.source === "permission" ||
                decision.source === "prose"
              ? "Answered in the terminal."
              : phrase(persona.voice, persona.name, { kind: "decision_cancelled" }),
        );
      }
    }
    sessions.refresh(decision.sessionId);
    if (decision.agentId && previous !== undefined) {
      const stillWaiting = decisions
        .pendingFor(decision.sessionId)
        .some((d) => d.agentId === decision.agentId);
      if (!stillWaiting) sessions.setCrewWaiting(decision.sessionId, decision.agentId, false);
    }
  });

  const sessions = new SessionStore({
    db,
    personas,
    log,
    emit,
    config,
    pendingFor: (id) => decisions.pendingFor(id),
    onMerge: (from, to) => decisions.reassign(from, to),
    onSessionGone: (id) => decisions.expireForSession(id),
    logger,
    ...deps,
  });

  // Sessions with a station of their own: voices are kept unique across these.
  tts.liveSessions = () =>
    sessions
      .all()
      .filter((s) => s.status !== "offline" && s.engaged !== false && !s.parentSessionId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((s) => ({ sessionId: s.id, persona: s.persona }));

  log.tagFor = (id) => sessions.childTag(id);
  log.holdFor = (id) => sessions.isHeld(id);

  /**
   * The terminal picker for AskUserQuestion / ExitPlanMode renders at the same
   * moment the gate hook starts, and whichever is answered first wins; the hook
   * is not killed when the terminal wins. Hooks that prove the prompt is over
   * (the tool finished, or the turn moved on) retire the now-stale card.
   * Scoped to the same agent so a subagent's hooks never clear the main thread's card.
   */
  const clearAnsweredElsewhere = (sessionId: string, event: string, payload: HookPayload) => {
    const tool = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
    const agentId = typeof payload.agent_id === "string" ? payload.agent_id : undefined;
    const toolUseId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : undefined;
    // A prose card waits for the user to reply in the terminal; any sign of the
    // main thread moving again (a prompt, a tool) means they did.
    if (!agentId && (event === "UserPromptSubmit" || event.includes("ToolUse"))) {
      for (const d of decisions.pendingFor(sessionId)) {
        if (d.source === "prose") decisions.cancel(d.id);
      }
    }
    if (event === "PreToolUse") {
      // PermissionRequest carries no tool_use_id (2.1.280), but it always follows the
      // PreToolUse for the same call, so remember the latest id per agent + tool.
      if (tool && toolUseId) lastToolUse.set(`${sessionId}|${agentId ?? ""}|${tool}`, toolUseId);
      return;
    }
    const toolDone = event === "PostToolUse" || event === "PostToolUseFailure";
    const turnOver = event === "UserPromptSubmit" || event === "Stop" || event === "SubagentStop";
    if (!toolDone && !turnOver) return;
    for (const d of decisions.pendingFor(sessionId)) {
      if (d.source !== "ask" && d.source !== "plan" && d.source !== "permission") continue;
      // (prose cards are handled above; Stop must not clear the one it is about to create)
      if (d.agentId !== agentId) continue;
      if (toolDone) {
        const gatedId = gateToolUse.get(d.id);
        // By id when we have one; by tool name otherwise (a parallel auto-allowed
        // call of the same tool could then retire a card early, leaving the
        // terminal prompt, which is the safe side).
        if (gatedId ? gatedId !== toolUseId : d.toolName !== tool) continue;
      }
      decisions.cancel(d.id);
    }
  };
  /**
   * A project wired both globally (~/.claude/settings.json) and per project runs
   * our hook twice per event with the same stdin. Identical deliveries within the
   * window are dropped (reporters) or joined (gate) so nothing double-logs.
   */
  const recentHooks = new Map<string, number>();
  const lastMessageAt = new Map<string, number>();
  /**
   * Gate decisions (permission/ask/plan) are only answerable while the hook's
   * curl is still connected: the answer travels back on that connection. Ids of
   * decisions with a live hook waiting; anything else is expired on sight.
   */
  const gateLive = new Set<string>();
  const expireNotes = new Map<string, string>();
  const expireWith = (id: string, note: string) => {
    expireNotes.set(id, note);
    decisions.expire(id);
    expireNotes.delete(id);
  };
  /** Decision ids being cancelled from the UI's Dismiss, so the log says so. */
  const dismissing = new Set<string>();
  /** Stop replies by fingerprint, so a double-wired Stop hook gets the same answer. */
  const stopReplies = new Map<string, { at: number; reply: StopResponse }>();
  const gateInflight = new Map<
    string,
    { promise: Promise<GateResponse>; live: number; hookGone: AbortController }
  >();
  const seenRecently = (key: string, now = Date.now()) => {
    // Map keeps insertion order, so expired keys are always at the front.
    for (const [k, at] of recentHooks) {
      if (now - at <= DEDUPE_WINDOW_MS) break;
      recentHooks.delete(k);
    }
    if (recentHooks.has(key)) return true;
    recentHooks.set(key, now);
    return false;
  };

  /** Gate decision id -> tool_use_id of the call it gates. */
  const gateToolUse = new Map<string, string>();
  const lastToolUse = new Map<string, string>();

  const sumTracker = new SumTracker();

  /**
   * Opt-in gate. Creates a decision and waits for the operator; if nobody answers
   * before the hook's own timeout we fall back to the terminal prompt so nothing
   * is silently allowed.
   */
  /**
   * The turn is ending. If Claude's final reply leaves questions in prose, block
   * the stop once (stop_hook_active is false) and ask it to use AskUserQuestion,
   * which the gate can route to the board. A nudged stop is not reported: Claude
   * carries straight on. If it stops again with questions (or the nudge is off),
   * report the stop and post a read-only prose card so the wait is visible.
   */
  function decideStop(meta: HookMeta | undefined, payload: HookPayload): StopResponse {
    const mainThread = typeof payload.agent_id !== "string";
    const text = !mainThread
      ? ""
      : typeof payload.last_assistant_message === "string"
        ? payload.last_assistant_message
        : typeof payload.transcript_path === "string"
          ? lastAssistantText(payload.transcript_path)
          : "";
    const questions = extractQuestions(text);
    if (questions.length > 0 && config.nudge && payload.stop_hook_active !== true) {
      logger.info(
        "nudge   ",
        hub.callsign(payload.session_id),
        `${questions.length} question(s) in prose`,
      );
      return { decision: "block", reason: NUDGE_REASON };
    }
    const rec = sessions.handleHook("Stop", meta, payload);
    if (rec) clearAnsweredElsewhere(rec.session.id, "Stop", payload);
    if (!rec || questions.length === 0) return {};
    for (const d of decisions.pendingFor(rec.session.id)) {
      if (d.source === "prose") decisions.cancel(d.id);
    }
    // Answerable only when we can reach the session: socket reply on and a live socket.
    const answerable =
      config.socketReply && socketExists(sessions.messaging(rec.session.id).socket);
    decisions.create({
      sessionId: rec.session.id,
      source: "prose",
      question: questions[0] as string,
      options: [],
      prose: { questions, message: text.slice(-PROSE_TAIL_CHARS) },
      recentContext: contextFor(rec.session.transcriptPath, { assistantText: text }),
      answerable,
      urgency: "normal",
      allowFreeText: answerable,
    });
    return {};
  }

  /**
   * The user's last prompt always comes from the session transcript. For a crew
   * member's card, Claude's text comes from that subagent's own transcript (the
   * main one only has the parent's words), else from the main one.
   */
  function cardContext(
    sessionId: string,
    transcriptPath: string | undefined,
    toolName: string,
    agentId: string | undefined,
  ) {
    const main = contextFor(transcriptPath, { toolName });
    if (!agentId) return main;
    const sub = contextFor(sessions.agentTranscript(sessionId, agentId), {
      toolName,
      sidechain: true,
    });
    const out = {
      ...(main?.lastPrompt ? { lastPrompt: main.lastPrompt } : {}),
      ...(sub?.assistantText ? { assistantText: sub.assistantText } : {}),
    };
    return out.lastPrompt || out.assistantText ? out : undefined;
  }

  async function runGate(
    meta: HookMeta | undefined,
    payload: HookPayload,
    hookGone: AbortSignal,
  ): Promise<GateResponse> {
    // PermissionRequest fires only when Claude Code would actually prompt, and
    // returning an empty body leaves that prompt in place. PreToolUse fires for
    // every call and a timed-out hook skips the tool, so it must answer "ask".
    const isPermReq = payload.hook_event_name === "PermissionRequest";
    const event = isPermReq ? "PermissionRequest" : "PreToolUse";
    const rec = sessions.handleHook(event, meta, payload);
    const tool = typeof payload.tool_name === "string" ? payload.tool_name : "tool";
    if (!rec) return isPermReq ? {} : ask("no session_id in hook payload");
    const agentId =
      typeof payload.agent_id === "string" && payload.agent_id ? payload.agent_id : undefined;
    const who = agentId ? { agentId, agentRole: crewRole(agentId, payload.agent_type) } : {};
    const input = payload.tool_input;
    const questions = tool === ASK_TOOL ? parseQuestions(input) : undefined;
    // Unparseable AskUserQuestion input: an Allow/Deny card could only return no answers.
    if (tool === ASK_TOOL && !questions) {
      return isPermReq ? {} : ask("could not read AskUserQuestion input");
    }
    const isPlan = tool === PLAN_TOOL;
    const first = questions?.[0];
    if (first || isPlan) {
      // A fresh prompt from the same agent supersedes any card the terminal already answered.
      for (const d of decisions.pendingFor(rec.session.id)) {
        if ((d.source === "ask" || d.source === "plan") && d.agentId === agentId) {
          decisions.cancel(d.id);
        }
      }
    }

    // What led here, from the transcript(s); see cardContext.
    const recent = cardContext(
      rec.session.id,
      typeof payload.transcript_path === "string"
        ? payload.transcript_path
        : rec.session.transcriptPath,
      tool,
      agentId,
    );
    const withCtx = recent?.lastPrompt || recent?.assistantText ? { recentContext: recent } : {};
    const preview = changePreview(tool, input);

    const decision = first
      ? decisions.create({
          ...withCtx,
          sessionId: rec.session.id,
          source: "ask",
          // question/options mirror the first question for clients that predate `questions`.
          question: first.question,
          options: first.options.map((o) => ({
            label: o.label,
            ...(o.description ? { description: o.description } : {}),
          })),
          questions,
          urgency: "normal",
          allowFreeText: true,
          toolName: tool,
          ...who,
        })
      : isPlan
        ? decisions.create({
            ...withCtx,
            sessionId: rec.session.id,
            source: "plan",
            question: "Approve this plan?",
            options: [
              {
                label: PLAN_APPROVE,
                description: "Leave plan mode and start. Edits still ask for permission.",
                recommended: true,
              },
              {
                label: PLAN_APPROVE_ACCEPT_EDITS,
                description: "Leave plan mode and let file edits run without prompting.",
              },
              { label: PLAN_KEEP, description: "Stay in plan mode. Your note goes to Claude." },
            ],
            plan: String((input as { plan?: unknown } | undefined)?.plan ?? ""),
            urgency: "normal",
            toolName: tool,
            ...who,
          })
        : decisions.create({
            ...withCtx,
            ...(preview ? { changePreview: preview } : {}),
            sessionId: rec.session.id,
            source: "permission",
            question: `Allow ${tool}?`,
            options: [
              {
                label: "Allow",
                description: `Let ${tool} run with this input.`,
                recommended: true,
              },
              { label: "Deny", description: "Block this call. Claude sees the reason you give." },
            ],
            context: summariseToolInput(input),
            urgency: "high",
            toolName: tool,
            toolInput: input,
            ...who,
          });

    const useId =
      payload.tool_use_id ?? lastToolUse.get(`${rec.session.id}|${agentId ?? ""}|${tool}`);
    if (useId) gateToolUse.set(decision.id, useId);
    gateLive.add(decision.id);
    const onGone = () => {
      if (decisions.get(decision.id)?.status === "pending") expireWith(decision.id, HOOK_GONE_NOTE);
    };
    if (hookGone.aborted) onGone();
    else hookGone.addEventListener("abort", onGone, { once: true });
    const result = await decisions.wait(decision.id, config.gateTimeoutMs);
    gateLive.delete(decision.id);
    hookGone.removeEventListener("abort", onGone);
    gateToolUse.delete(decision.id);
    if (result.status !== "answered") {
      if (result.status === "pending") decisions.expire(decision.id);
      return isPermReq ? {} : ask("no answer from mission control in time");
    }

    let allow: boolean;
    let reason: string;
    let updatedInput: unknown;
    let updatedPermissions: unknown[] | undefined;
    if (first) {
      // AskUserQuestion reads the operator's picks from updatedInput.answers,
      // keyed by question text; the rest of the input goes back unchanged.
      allow = true;
      reason = "The user answered.";
      updatedInput = { ...(input as object), answers: result.answers ?? {} };
    } else if (isPlan) {
      allow = result.answer === PLAN_APPROVE || result.answer === PLAN_APPROVE_ACCEPT_EDITS;
      reason = allow ? "The user approved the plan." : keepPlanningMessage(result.note);
      // Without updatedInput the approval does not take: the terminal menu stays up.
      if (allow) updatedInput = input;
      if (result.answer === PLAN_APPROVE_ACCEPT_EDITS) {
        updatedPermissions = [{ type: "setMode", mode: "acceptEdits", destination: "session" }];
      }
    } else {
      allow = result.answer === "Allow";
      reason = allow
        ? (result.note ?? "The user approved this call.")
        : permissionDenyMessage(tool, result.note);
    }
    const extra = {
      ...(updatedInput !== undefined ? { updatedInput } : {}),
      ...(updatedPermissions ? { updatedPermissions } : {}),
    };
    if (isPermReq) {
      return {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: allow ? { behavior: "allow", ...extra } : { behavior: "deny", message: reason },
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: allow ? "allow" : "deny",
        permissionDecisionReason: reason,
        ...(updatedInput !== undefined ? { updatedInput } : {}),
      },
    };
  }

  const hub: Hub = {
    config,
    db,
    sessions,
    decisions,
    log,
    broadcaster,
    logger,
    tts,

    callsign(sessionId) {
      return sessionId ? sessions.persona(sessionId)?.name : undefined;
    },

    snapshot() {
      return {
        sessions: sessions.all(),
        decisions: decisions.pending(),
        log: log.recent(200),
        recentActivity: activity.recent(sessions.all().map((s) => s.id)),
        serverTime: new Date().toISOString(),
      };
    },

    stopHook(meta, payload) {
      if (
        ignore.check(payload.session_id, typeof payload.cwd === "string" ? payload.cwd : undefined)
      ) {
        return {};
      }
      const now = Date.now();
      for (const [k, v] of stopReplies) if (now - v.at > DEDUPE_WINDOW_MS) stopReplies.delete(k);
      const key = hookFingerprint(payload);
      const cached = stopReplies.get(key);
      if (cached) return cached.reply;

      const reply = decideStop(meta, payload);
      stopReplies.set(key, { at: now, reply });
      return reply;
    },

    dismissDecision(id) {
      dismissing.add(id);
      const d = decisions.cancel(id);
      dismissing.delete(id);
      return d;
    },

    isIgnored(sessionId, cwd) {
      return ignore.check(sessionId, cwd);
    },

    handleHook(event, meta, payload) {
      if (
        ignore.check(payload.session_id, typeof payload.cwd === "string" ? payload.cwd : undefined)
      ) {
        return "ignored";
      }
      if (seenRecently(`${event}|${hookFingerprint(payload)}`)) return "duplicate";
      const rec = sessions.handleHook(event, meta, payload);
      if (rec) clearAnsweredElsewhere(rec.session.id, event, payload);
      return "ok";
    },

    /**
     * Opt-in permission gate. Creates a permission decision and waits for the
     * operator; if nobody answers before the hook's own timeout we fall back to
     * the terminal prompt so nothing is silently allowed.
     */
    gate(meta, payload, signal) {
      // Ignored sessions keep Claude Code's normal behaviour: no card, no wait.
      if (
        ignore.check(payload.session_id, typeof payload.cwd === "string" ? payload.cwd : undefined)
      ) {
        return Promise.resolve({});
      }
      // A project wired both globally and per project runs two identical gate
      // hooks for one prompt; both get the one card's answer.
      const key = hookFingerprint(payload);
      let entry = gateInflight.get(key);
      if (!entry) {
        const hookGone = new AbortController();
        const promise = runGate(meta, payload, hookGone.signal);
        entry = { promise, live: 0, hookGone };
        gateInflight.set(key, entry);
        // Only while in flight: both copies start together, and an identical prompt
        // after this one settles is a new prompt (Claude retrying the same command).
        promise.finally(() => gateInflight.delete(key));
      }
      const e = entry;
      e.live++;
      // The card goes when the last hook connection waiting on it goes.
      signal?.addEventListener("abort", () => {
        if (--e.live === 0) e.hookGone.abort();
      });
      return e.promise;
    },

    requestDecision(req) {
      const rec = sessions.correlate({
        sessionId: req.sessionId,
        ancestorPids: req.ancestorPids,
        cwd: req.cwd,
      });
      // Attribution only ever comes from the PreToolUse match, never from the request body.
      const who = sessions.claimCrewAsk(rec.session.id, req.question);
      const ctx = cardContext(
        rec.session.id,
        rec.session.transcriptPath,
        REQUEST_DECISION_TOOL,
        who?.agentId,
      );
      const decision = decisions.create({
        ...req,
        ...(ctx ? { recentContext: ctx } : {}),
        // The operator can always type a reply to an MCP question (user ruling);
        // the MCP server tells Claude when the answer was typed.
        allowFreeText: req.source === "mcp" ? true : req.allowFreeText,
        sessionId: rec.session.id,
        agentId: who?.agentId,
        agentRole: who?.agentRole,
      });
      if (who) sessions.setCrewWaiting(rec.session.id, who.agentId, true);
      return decision;
    },

    async answerDecision(id, body) {
      const d = decisions.get(id);
      if (d?.status === "pending" && d.source === "prose") {
        if (!d.answerable) {
          return {
            ok: false,
            code: 409,
            error: "this card cannot deliver an answer; reply in the terminal",
            reason: "not_answerable",
          };
        }
        const text = body.answer.trim();
        if (!text) return { ok: false, code: 400, error: "answer is required" };
        const { socket, token } = sessions.messaging(d.sessionId);
        try {
          if (!socket) throw new Error("no messaging socket known for this session");
          await deliverToSession(socket, wrapAnswer(text, body.note), token);
        } catch (err) {
          // Keep the card, but tell the UI to fall back to "answer in the terminal".
          decisions.setAnswerable(id, false);
          logger.info("decision", "delivery failed", hub.callsign(d.sessionId), String(err));
          return {
            ok: false,
            code: 502,
            error: `could not deliver the answer to the session: ${String(err)}`,
            reason: "delivery_failed",
          };
        }
        return decisions.answer(id, text, body.note);
      }
      if (d?.status === "pending" && GATE_SOURCES.has(d.source) && !gateLive.has(id)) {
        // Nobody is listening for this answer any more (hub restart, curl died).
        expireWith(id, HOOK_GONE_NOTE);
        return {
          ok: false,
          code: 409,
          error: "the terminal prompt for this card is no longer waiting; answer in the terminal",
          reason: "not_waiting",
        };
      }
      return decisions.answer(id, body.answer, body.note, body.answers);
    },

    async messageSession(id, text) {
      const s = sessions.get(id);
      if (!s || ignore.has(id)) {
        return { ok: false, code: 404, error: "no such session", reason: "unknown_session" };
      }
      const now = Date.now();
      if (now - (lastMessageAt.get(id) ?? 0) < MESSAGE_INTERVAL_MS) {
        return {
          ok: false,
          code: 429,
          error: "one message every 2 seconds per session",
          reason: "rate_limited",
        };
      }
      const { socket, token } = sessions.messaging(id);
      if (!config.socketReply || !socket || !socketExists(socket)) {
        return {
          ok: false,
          code: 409,
          error: "this session has no messaging socket to deliver to",
          reason: "no_socket",
        };
      }
      lastMessageAt.set(id, now);
      try {
        await deliverToSession(socket, wrapMessage(text), token);
      } catch (err) {
        return {
          ok: false,
          code: 502,
          error: `could not deliver the message: ${String(err)}`,
          reason: "delivery_failed",
        };
      }
      sessions.engage(id);
      log.add(
        s.persona,
        "note",
        `Operator: ${text.length > 120 ? `${text.slice(0, 117)}...` : text}`,
        {
          meta: { from: "operator", text },
        },
      );
      logger.info("message ", s.persona.name, `${text.length} chars`);
      return { ok: true };
    },

    releaseGates() {
      for (const id of [...gateLive]) expireWith(id, HOOK_GONE_NOTE);
    },

    reportStatus(input) {
      const rec = sessions.correlate(input);
      sessions.setStatusLine(rec.session.id, input.line);
      logger.info("status", rec.session.persona.name, JSON.stringify(input.line));
      return rec.session.id;
    },

    ingestOtlpLogs(body) {
      const events = parseOtlpLogs(body);
      logger.event(
        "otlp",
        [`logs=${events.length}`, hub.callsign(events[0]?.sessionId)],
        () => `events=[${[...new Set(events.map((e) => e.eventName))].join(",")}]`,
      );
      for (const ev of events) {
        if (!ev.sessionId || ignore.has(ev.sessionId)) continue;
        const a = ev.attrs;
        const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
        const num = (k: string) => (typeof a[k] === "number" ? (a[k] as number) : undefined);
        // The log body says "claude_code.user_prompt" but the event.name attribute is
        // the bare "user_prompt"; accept both.
        switch (ev.eventName.replace(/^claude_code\./, "")) {
          case "user_prompt":
            sessions.otlpActivity(ev.sessionId, { resumesWork: true });
            break;
          case "tool_result":
            sessions.otlpActivity(ev.sessionId, { tool: str("tool_name") ?? str("name") });
            break;
          case "tool_decision":
            sessions.otlpActivity(ev.sessionId, {
              tool: str("tool_name"),
              resumesWork: str("decision") === "accept",
            });
            break;
          case "api_request":
            sessions.otlpActivity(ev.sessionId, { model: str("model"), resumesWork: true });
            sessions.addUsage(ev.sessionId, {
              inputTokens:
                (num("input_tokens") ?? 0) +
                (num("cache_read_tokens") ?? 0) +
                (num("cache_creation_tokens") ?? 0),
              outputTokens: num("output_tokens"),
              costUsd: num("cost_usd"),
              fromMetrics: false,
            });
            break;
          case "api_error":
            sessions.otlpActivity(ev.sessionId, {
              line: `API error: ${str("error") ?? "unknown"}`,
            });
            break;
          default:
            sessions.otlpActivity(ev.sessionId, {});
        }
      }
      return events.length;
    },

    ingestOtlpMetrics(body) {
      const points = parseOtlpMetrics(body);
      logger.event(
        "otlp",
        [`metrics=${points.length}`, hub.callsign(points[0]?.sessionId)],
        () => `names=[${[...new Set(points.map((p) => p.metric))].join(",")}]`,
      );
      for (const [sessionId, usage] of usageFromMetrics(points, sumTracker)) {
        if (ignore.has(sessionId)) continue;
        sessions.addUsage(sessionId, { ...usage, fromMetrics: true });
      }
      return points.length;
    },

    stop() {
      clearInterval(sweepTimer);
      sessions.dispose();
      tts.stop();
      db.close();
    },
  };

  // A gate card reloaded from SQLite has no hook behind it any more (its curl
  // died with the old process), so it can never deliver an answer. mcp
  // decisions are different: their long-poll reconnects by id.
  for (const d of decisions.pending()) {
    if (GATE_SOURCES.has(d.source)) expireWith(d.id, HOOK_GONE_NOTE);
  }

  const sweepTimer = setInterval(() => sessions.sweep(), 30_000);
  sweepTimer.unref?.();
  return hub;
}

/**
 * The UI files, URL path ("/index.html", "/assets/x.png") -> file path. The amc
 * binary passes its embedded copy (paths into Bun's /$bunfs); without one the
 * hub serves apps/web/dist from the checkout.
 */
export type WebAssets = Record<string, string>;

export function startServer(
  hub: Hub,
  opts: { port?: number; host?: string; webAssets?: WebAssets } = {},
): Server<WsData> {
  const router = createRouter(hub);
  const guard = createGuard(hub.config, hub.logger);
  const { webAssets } = opts;
  const serveUi = webAssets
    ? (pathname: string) => serveEmbedded(webAssets, pathname)
    : diskUi(path.resolve(import.meta.dir, "../../web/dist"));

  return Bun.serve<WsData>({
    hostname: opts.host ?? hub.config.host,
    port: opts.port ?? hub.config.port,
    idleTimeout: 60,
    async fetch(req, server) {
      const blocked = guard(req, server.port ?? hub.config.port);
      if (blocked) return blocked;
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const ok = server.upgrade(req, { data: { id: crypto.randomUUID() } });
        return ok ? undefined : new Response("websocket upgrade failed", { status: 400 });
      }
      const routed = await router(req, url);
      if (routed) return routed;
      if (
        req.method === "GET" &&
        !url.pathname.startsWith("/api") &&
        !url.pathname.startsWith("/v1")
      ) {
        return serveUi(url.pathname);
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      open(ws) {
        hub.broadcaster.add(ws, () => hub.snapshot());
      },
      close(ws) {
        hub.broadcaster.remove(ws);
      },
      message() {
        // UI answers over HTTP; inbound WS messages are ignored on purpose.
      },
    },
  });
}

const uiNotBuilt = () =>
  new Response(
    "Mission control UI is not built. Run `task build` (or `task dev` for the Vite dev server on :5173).\n",
    { status: 404, headers: { "content-type": "text/plain" } },
  );

function diskUi(webDist: string): (pathname: string) => Promise<Response> {
  const hasDist = fs.existsSync(path.join(webDist, "index.html"));
  return async (pathname) => {
    if (!hasDist) return uiNotBuilt();
    const safe = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
    const candidate = path.join(webDist, safe);
    if (candidate.startsWith(webDist)) {
      const file = Bun.file(candidate);
      if (await file.exists()) return new Response(file);
    }
    // SPA fallback
    return new Response(Bun.file(path.join(webDist, "index.html")));
  };
}

/** Exact-key lookup, so there is nothing to traverse; unknown paths get the SPA shell. */
function serveEmbedded(assets: WebAssets, pathname: string): Response {
  const key = pathname === "/" || !assets[pathname] ? "/index.html" : pathname;
  const file = assets[key];
  if (!file) return uiNotBuilt();
  // Embedded names carry a content hash, so the type comes from the URL key.
  return new Response(Bun.file(file), { headers: { "content-type": Bun.file(key).type } });
}

const DEDUPE_WINDOW_MS = 2_000;
const MESSAGE_INTERVAL_MS = 2_000;
export const MAX_MESSAGE_CHARS = 4_000;
const REQUEST_DECISION_TOOL = "mcp__mission-control__request_decision";

/** Best-effort card context; never throws, never slows a hook by more than a tail read. */
function contextFor(
  transcriptPath: string | undefined,
  opts: { toolName?: string; assistantText?: string; sidechain?: boolean },
) {
  try {
    return recentContext(transcriptPath, opts);
  } catch {
    return undefined;
  }
}
const GATE_SOURCES = new Set(["permission", "ask", "plan"]);
const HOOK_GONE_NOTE = "Hub restarted; answer in the terminal.";

/** Same session, event and payload: the whole stdin body, which both copies of a double-wired hook share. */
function hookFingerprint(payload: HookPayload): string {
  return `${payload.session_id}|${payload.hook_event_name}|${Bun.hash(JSON.stringify(payload))}`;
}

function ask(reason: string): GateResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason,
    },
  };
}

function kindFor(d: Decision) {
  switch (d.status) {
    case "pending":
      return "decision_requested";
    case "answered":
      return "decision_answered";
    default:
      return "decision_expired";
  }
}

/** Keep the gate card readable: command for Bash, path for file tools, else compact JSON. */
function summariseToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  if (typeof obj.command === "string") return obj.command;
  if (typeof obj.file_path === "string") return obj.file_path;
  const json = JSON.stringify(obj);
  return json.length > 800 ? `${json.slice(0, 800)}...` : json;
}
