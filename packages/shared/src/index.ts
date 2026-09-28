/**
 * @amc/shared — the wire contract between the hub, the MCP server, the hook
 * scripts and the web UI. This file is the single source of truth: if you change
 * a shape here, every consumer breaks at typecheck time, which is the point.
 *
 * Ports / URLs
 *   Hub default port: 4242 (env AMC_PORT). Everything below is relative to it.
 *   Web dev server (Vite) runs on 5173 and proxies /api, /ws and /v1 to the hub.
 */

export const DEFAULT_HUB_PORT = 4242;
export const DEFAULT_HUB_URL = `http://127.0.0.1:${DEFAULT_HUB_PORT}`;

// ───────────────────────────────────────────────────────────────────────────
// Sessions & personas
// ───────────────────────────────────────────────────────────────────────────

/** Coarse state shown on a station. Derived by the hub from hooks + OTLP. */
export type SessionStatus =
  | "working" // tool calls / API requests flowing
  | "waiting_decision" // a request_decision is pending in the UI
  | "waiting_permission" // Claude Code showed a permission prompt in the terminal
  | "idle" // Notification idle_prompt fired / Stop with nothing pending
  | "offline"; // SessionEnd, or no signal for a long time

export interface Persona {
  /** Stable per session_id. Generated once by the hub, persisted. */
  sessionId: string;
  /** Callsign, e.g. "NOVA", "RASCAL". Unique among live sessions where possible. */
  name: string;
  /** Seed for the procedural pixel sprite (UI renders it; hub never draws). */
  spriteSeed: number;
  /** One of the UI's phosphor palette keys: amber | green | cyan | magenta | red | blue */
  color: PersonaColor;
  /** Voice used to phrase status lines. */
  voice: PersonaVoice;
  /** One-liner flavour text, shown on hover / in the log. */
  tagline: string;
}

export type PersonaColor = "amber" | "green" | "cyan" | "magenta" | "red" | "blue";

export type PersonaVoice =
  | "deadpan"
  | "gungho"
  | "anxious"
  | "noir"
  | "bureaucrat"
  | "pirate"
  | "robot";

export interface Session {
  id: string; // Claude Code session_id
  persona: Persona;
  status: SessionStatus;
  /** Project directory (cwd from hooks). Used as the station's subtitle. */
  cwd: string;
  /** Short project label derived from cwd basename. */
  project: string;
  /** PID of the `claude` process, if known (from hooks' $PPID). Used to correlate MCP calls. */
  claudePid?: number;
  transcriptPath?: string;
  /** Model reported by OTLP events, if any. */
  model?: string;
  startedAt: string; // ISO
  lastSeenAt: string; // ISO
  /** When the current blocking state began (decision/permission/idle). Drives escalation. */
  blockedSince?: string;
  /** Last tool name seen (PreToolUse/PostToolUse or OTLP tool_result). */
  lastTool?: string;
  /** Rolling activity line, phrased by the hub in the persona's voice. */
  statusLine: string;
  /** Aggregates from OTLP metrics if enabled. */
  stats: {
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    decisionsAnswered: number;
  };
  /**
   * Set when this session is a separate `claude` process started underneath
   * another live session (nested `claude -p`, split-pane teammate). Detected by
   * walking the process ancestry at SessionStart. The UI shows such sessions in
   * the parent's crew bay instead of giving them a station.
   */
  parentSessionId?: string;
  /**
   * True once the session has done something a human would care about: a user
   * prompt, a main-thread tool call, or a decision. Background `claude` runs that
   * start and end without any of these stay false and the UI hides them (no
   * station, no off-shift chip, no log lines). Absent on older hubs = treat as true.
   */
  engaged?: boolean;
  /**
   * The operator can send this session a free message (POST
   * /api/sessions/:id/message): socket replies are enabled and the session's
   * messaging socket exists. Absent on older hubs = false.
   */
  canMessage?: boolean;
  /**
   * In-process child agents of this session: Task-tool subagents and in-process
   * teammates. They share the parent's session_id; hooks fired inside them carry
   * `agent_id` + `agent_type`. Includes recently finished agents (status "done")
   * for a short grace period so the bay does not flicker, and teammates between
   * tasks (status "standby") for as long as they are still on the team.
   */
  crew: CrewMember[];
}

export interface CrewMember {
  /** Claude Code agent_id from hooks, or the child session id for nested sessions. */
  id: string;
  kind: "subagent" | "teammate" | "child_session";
  /** Teammate name, else agent_type from hooks (e.g. "general-purpose", "Explore"). */
  role: string;
  /**
   * Short display name for a subagent, from the Agent tool call that spawned it:
   * tool_input.name, else its description cut to ~16 chars. Absent: show role.
   */
  label?: string;
  /** Agent team (~/.claude/teams/<team>) a teammate belongs to, when known. */
  team?: string;
  /** Small deterministic sprite/colour, derived from the parent persona + id. */
  spriteSeed: number;
  /**
   * "standby": a teammate between tasks, still on the team. It fired SubagentStop /
   * TeammateIdle and will be back on its next hook. Not busy: the parent may go idle.
   * Only kind "teammate" uses it; subagents go straight to "done".
   */
  status: "working" | "waiting_decision" | "standby" | "done";
  startedAt: string;
  lastSeenAt: string;
  endedAt?: string;
  lastTool?: string;
  toolCalls: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Decisions (the primary channel: MCP request_decision → hub → UI → back)
// ───────────────────────────────────────────────────────────────────────────

export type Urgency = "low" | "normal" | "high" | "critical";

export interface DecisionOption {
  /** Short label shown on the button, e.g. "Use Postgres". */
  label: string;
  /** Optional longer description / consequence. */
  description?: string;
  /** Mark one as the recommended option; UI highlights it. */
  recommended?: boolean;
}

export type DecisionSource =
  | "mcp" // request_decision tool
  | "permission" // PermissionRequest gate (opt-in), options are allow/deny
  | "ask" // Claude Code's AskUserQuestion tool, intercepted by the gate; see `questions`
  | "plan" // ExitPlanMode (plan approval), intercepted by the gate; see `plan`
  | "prose" // Claude ended its turn with questions in plain text; see `prose`
  | "hook"; // synthesized from a Notification (informational, may not be answerable)

/**
 * One question from an AskUserQuestion call (1 to 4 per call, 2 to 4 options each).
 * Mirrors Claude Code's tool input so the gate can hand it back unchanged.
 */
export interface AskQuestion {
  question: string;
  /** Short chip label, max 12 chars. */
  header: string;
  options: { label: string; description?: string; preview?: string }[];
  multiSelect: boolean;
}

export type DecisionStatus = "pending" | "answered" | "expired" | "cancelled";

export interface Decision {
  id: string;
  sessionId: string;
  source: DecisionSource;
  question: string;
  options: DecisionOption[];
  /** Free text context the agent supplied: what it was doing, why it's asking, relevant snippets. */
  context?: string;
  urgency: Urgency;
  status: DecisionStatus;
  createdAt: string;
  answeredAt?: string;
  /** The chosen option label, or free text if `allowFreeText` and none matched. */
  answer?: string;
  /** Optional operator note passed back to the agent verbatim. */
  note?: string;
  /** source=ask, once answered: question text -> label(s) or free text, as handed to Claude Code. */
  answers?: Record<string, string | string[]>;
  allowFreeText: boolean;
  /**
   * source=ask: every question in the call. `question`/`options` above hold the
   * first one for older clients; new UIs render all of these and answer with
   * DecisionAnswerBody.answers. Free text is always allowed per question.
   */
  questions?: AskQuestion[];
  /** source=plan: the plan text (markdown) Claude wants approved. Options are Approve / Keep planning. */
  plan?: string;
  /**
   * source=prose: the turn ended with open questions written as text, so no tool
   * call exists to answer. `questions` are the extracted question sentences,
   * `message` the tail of Claude's final reply for context. Cleared automatically
   * when the user next prompts that session (UserPromptSubmit).
   */
  prose?: { questions: string[]; message: string };
  /**
   * What was going on when the card was raised, read by the hub from the
   * session transcript tail (and Stop's last_assistant_message), so the operator
   * can decide without switching to the terminal. Text only, trimmed.
   */
  recentContext?: {
    /** The user's most recent prompt in that session (trimmed ~600 chars). */
    lastPrompt?: string;
    /** Claude's text immediately before the question/tool call (trimmed ~1500 chars). */
    assistantText?: string;
  };
  /**
   * For gated Edit/Write/MultiEdit/NotebookEdit: a compact preview of the change.
   * `diff` is a unified-style diff (Edit/MultiEdit) or the head of new content (Write),
   * capped ~120 lines; `truncated` says more was cut.
   */
  changePreview?: { filePath: string; diff: string; truncated: boolean };
  /**
   * false when the hub cannot deliver an answer back into the session (e.g. a
   * prose card with no delivery route): the UI shows "answer in the terminal"
   * plus a Dismiss action instead of option buttons. Absent means answerable.
   */
  answerable?: boolean;
  /** For source=permission: the tool being gated. */
  toolName?: string;
  toolInput?: unknown;
  /** Set when the decision came from a child agent of `sessionId` (see CrewMember). */
  agentId?: string;
  agentRole?: string;
}

/** Escalation tiers, computed client-side from `blockedSince`/`createdAt` (ms). */
export const ESCALATION_TIERS_MS = {
  calm: 0,
  amber: 2 * 60_000,
  red: 5 * 60_000,
  alarm: 10 * 60_000,
} as const;
export type EscalationTier = keyof typeof ESCALATION_TIERS_MS;

export function escalationTier(sinceIso: string | undefined, now = Date.now()): EscalationTier {
  if (!sinceIso) return "calm";
  const waited = now - Date.parse(sinceIso);
  if (waited >= ESCALATION_TIERS_MS.alarm) return "alarm";
  if (waited >= ESCALATION_TIERS_MS.red) return "red";
  if (waited >= ESCALATION_TIERS_MS.amber) return "amber";
  return "calm";
}

// ───────────────────────────────────────────────────────────────────────────
// Mission log
// ───────────────────────────────────────────────────────────────────────────

export type LogKind =
  | "session_start"
  | "session_end"
  | "decision_requested"
  | "decision_answered"
  | "decision_expired"
  | "permission_prompt"
  | "idle"
  | "stop"
  | "tool"
  | "note";

export interface LogEntry {
  id: string;
  at: string;
  sessionId: string;
  persona: Pick<Persona, "name" | "color" | "spriteSeed">;
  kind: LogKind;
  /** Human line, already phrased in the persona voice by the hub. */
  text: string;
  decisionId?: string;
  /** Extra structured payload (tool name, answer, etc.) */
  meta?: Record<string, unknown>;
  /** Set when the entry is about a child agent; the UI can group or hide these. */
  agentId?: string;
  agentRole?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// HTTP API (hub)
// ───────────────────────────────────────────────────────────────────────────

/** GET /api/state → full snapshot for initial render / reconnect. */
export interface StateSnapshot {
  sessions: Session[];
  decisions: Decision[]; // pending only
  log: LogEntry[]; // most recent N (default 200), newest last
  /**
   * Each station's recent activity lines (up to 80 per session, oldest first),
   * kept by the hub across page reloads and restarts so the UI can seed its
   * per-station history. Only sessions in `sessions` are included. Absent from
   * older hubs.
   */
  recentActivity?: Record<string, { at: string; line: string }[]>;
  serverTime: string;
}

/**
 * POST /api/decisions  (from MCP server or PreToolUse gate)
 * Body: DecisionRequest → 201 { id }
 *
 * Session correlation: the MCP server does not know the Claude Code session_id.
 * It sends the PIDs of its ancestor processes (`ancestorPids`); the hub matches
 * them against `claudePid` values reported by hooks. Fallback: `cwd` match on a
 * single live session. If nothing matches, the hub creates a provisional session
 * keyed `pid:<ppid>` and merges it once a hook reports the real id.
 */
export interface DecisionRequest {
  sessionId?: string; // if the caller knows it (PreToolUse gate does)
  ancestorPids?: number[];
  cwd?: string;
  source: DecisionSource;
  question: string;
  options: DecisionOption[];
  context?: string;
  urgency?: Urgency;
  allowFreeText?: boolean;
  toolName?: string;
  toolInput?: unknown;
}

/**
 * GET /api/decisions/:id/wait?timeoutMs=25000  (long-poll from MCP server)
 * → 200 DecisionWaitResponse. `pending` on timeout: caller loops.
 */
export type DecisionWaitResponse =
  | { status: "pending" }
  | {
      status: "answered";
      answer: string;
      note?: string;
      answers?: Record<string, string | string[]>;
    }
  | { status: "expired" | "cancelled" };

/** POST /api/decisions/:id/answer  (from UI) */
export interface DecisionAnswerBody {
  /** Chosen option label or free text. For source=ask, a readable summary of `answers`. */
  answer: string;
  note?: string;
  /**
   * source=ask only: question text -> chosen label, custom text, or labels for
   * multiSelect. Returned to Claude Code verbatim as AskUserQuestion's `answers`.
   */
  answers?: Record<string, string | string[]>;
}

/** POST /api/decisions/:id/cancel (from MCP server when the tool call is aborted) */

/**
 * POST /api/hooks/:event  (from Claude Code hook scripts)
 * Body: the raw hook stdin JSON. Header `X-Claude-Pid`: the hook shell's $PPID.
 * :event is the hook_event_name (SessionStart, Notification, PreToolUse, …).
 * Always 200 {} — hooks must never block Claude on our account (except the opt-in gate).
 */
export interface HookPayload {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: string;
  // Notification
  notification_type?: "permission_prompt" | "idle_prompt" | string;
  message?: string;
  // Pre/PostToolUse
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  /** PreToolUse / PostToolUse / PostToolUseFailure; absent on PermissionRequest (2.1.280). */
  tool_use_id?: string;
  // Present only on hooks fired inside a subagent / in-process teammate.
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
  // Stop
  stop_hook_active?: boolean;
  /** Stop: text of Claude's final reply (2.1.280). */
  last_assistant_message?: string;
  // SessionStart
  source?: string;
  [k: string]: unknown;
}

/**
 * POST /api/hooks/gate  (opt-in PreToolUse gate)
 * Same body as above; the hub creates a `permission` Decision and long-polls
 * internally up to `AMC_GATE_TIMEOUT_MS` (default 55s, under the hook's 60s).
 * Responds with the hook JSON output Claude Code expects, e.g.
 *   { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" | "deny" | "ask", permissionDecisionReason } }
 * On timeout → "ask" so the terminal prompt still appears.
 */

// ───────────────────────────────────────────────────────────────────────────
// WebSocket  /ws  (hub → UI push; UI → hub for answers is HTTP, keep it simple)
// ───────────────────────────────────────────────────────────────────────────

export type ServerEvent =
  | { type: "snapshot"; state: StateSnapshot }
  | { type: "session"; session: Session }
  | { type: "session_removed"; sessionId: string }
  | { type: "decision"; decision: Decision }
  | { type: "log"; entry: LogEntry }
  | { type: "activity"; sessionId: string; line: string; at: string }; // high-frequency, not logged

// ───────────────────────────────────────────────────────────────────────────
// OTLP  (hub accepts OTLP/HTTP JSON on /v1/logs, /v1/metrics, /v1/traces)
// Claude Code env: CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_EXPORTER_OTLP_PROTOCOL=http/json
//   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4242 OTEL_LOGS_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp
// Events of interest (log records, attribute event.name): claude_code.user_prompt,
//   claude_code.tool_result, claude_code.api_request, claude_code.api_error, claude_code.tool_decision
// All carry session.id — the hub uses that to attach activity to a session.
// ───────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Voice: optional ElevenLabs provider behind the hub (browser speech is the default)
// ─────────────────────────────────────────────────────────────────────────────

export type VoiceProvider = "browser" | "elevenlabs";

/** GET /api/voice/status. The API key itself never leaves the hub; only `configured`. */
export interface VoiceStatus {
  providers: {
    browser: true;
    elevenlabs: {
      configured: boolean;
      /** Where the hub's key came from (never the key itself); null when unconfigured. */
      keySource?: "env" | "secrets.env" | null;
      voices?: { id: string; name: string }[];
      /** Why the voice list could not be loaded (bad key, offline...). */
      error?: string;
    };
  };
  dailyCharsUsed: number;
  dailyCharsCap: number;
  /** ElevenLabs voice of each live session (unique while voices last). Names only. */
  assignments?: { sessionId: string; voiceName: string }[];
}

/** POST /api/voice/assign: `next: true` re-rolls the session to its next best unused voice. */
export interface VoiceAssignRequest {
  sessionId: string;
  next?: boolean;
}

/**
 * POST /api/voice/speak. `text` is an announcement line from shared/phrases, never card content.
 * The voice comes from the session's persona, or `persona` for lines with no session (tests).
 */
export interface SpeakRequest {
  text: string;
  sessionId?: string;
  persona?: Pick<Persona, "voice" | "spriteSeed">;
}

/** Non-audio answer from /api/voice/speak; the UI falls back to browser speech on any of these. */
export interface SpeakFailure {
  error: string;
  reason: "not_configured" | "cap_reached" | "bad_request" | "no_voice" | "upstream" | "timeout";
}

/** Longest line /api/voice/speak accepts; real announcements are well under this. */
export const SPEAK_MAX_CHARS = 200;
