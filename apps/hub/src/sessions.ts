import type { Database } from "bun:sqlite";
import path from "node:path";
import type {
  CrewMember,
  Decision,
  HookPayload,
  Persona,
  ServerEvent,
  Session,
  SessionStatus,
} from "@amc/shared";
import type { HubConfig } from "./config";
import {
  type AncestryResolver,
  CREW_ASK_TTL_MS,
  CREW_GRACE_MS,
  crewKind,
  crewRole,
  isRequestDecisionTool,
  psAncestry,
  SPAWN_TOOLS,
  spawnLabel,
} from "./crew";
import { toolTarget, withTarget } from "./detail";
import { ASK_TOOL, PLAN_TOOL } from "./gate";
import { type HubLogger, shortPath } from "./hublog";
import type { LogStore } from "./log";
import { hashString, type PersonaStore } from "./personas";
import { socketExists } from "./socket";
import {
  listTeammates,
  readTeammateMeta,
  type TeamInfo,
  type TeammateMeta,
  TeamRoster,
  teammateName,
} from "./teams";
import { phrase, type VoiceEvent } from "./voice";

/**
 * AskUserQuestion and ExitPlanMode raise a PermissionRequest too, but the gate
 * logs them as questions ("Asked 2 questions"), so no separate permission line.
 */
function isQuestionTool(tool: string | undefined): boolean {
  return tool === ASK_TOOL || tool === PLAN_TOOL;
}

interface SessionRecord {
  session: Session;
  /** Status as driven by hooks/OTLP only; a pending decision overrides it at derive time. */
  hookStatus: SessionStatus;
  hookBlockedSince?: string;
  /**
   * The main thread went idle (Stop / idle_prompt) while crew was busy, so the
   * session is shown as working. derive() makes it idle, with a fresh
   * blockedSince, the moment the last busy crew member is done.
   */
  idleHeldByCrew?: boolean;
  /** Only meaningful for provisional sessions: the MCP server's ancestor pids. */
  ancestorPids: number[];
  provisional: boolean;
  /** Once OTLP metrics arrive we stop counting tokens from api_request log events. */
  metricsSeen: boolean;
  /**
   * Claude Code's per-session messaging socket (/tmp/cc-socks/<pid>.sock), reported
   * by hooks as X-Claude-Socket; answers to prose cards are delivered through it
   * (see socket.ts).
   */
  messagingSocket?: string;
  /**
   * CLAUDE_CODE_MESSAGING_TOKEN (X-Claude-Token), the socket's auth token. A
   * secret: it lives only in this record and the sqlite file, never in Session
   * (which goes to the UI) and never in a log line.
   */
  messagingToken?: string;
  /** Crew member whose permission prompt put the session in waiting_permission. */
  permissionAgentId?: string;
}

export interface HookMeta {
  claudePid?: number;
  /** Parent of the claude process (X-Claude-Ppid, SessionStart only): the start of the ancestry walk. */
  parentPid?: number;
  socket?: string;
  /** X-Claude-Token; see SessionRecord.messagingToken. */
  token?: string;
}

/** A crew member's request_decision call, seen in PreToolUse, waiting for its POST /api/decisions. */
interface CrewAsk {
  agentId: string;
  agentRole: string;
  question: string;
  at: number;
}

/** Fields persisted alongside the public Session shape. */
type PersistedRecord = Omit<SessionRecord, "session"> & { session: Session };

export interface SessionStoreDeps {
  db: Database;
  personas: PersonaStore;
  log: LogStore;
  emit: (ev: ServerEvent) => void;
  config: HubConfig;
  pendingFor: (sessionId: string) => Decision[];
  /** Called when a provisional session is folded into a real one (move decisions etc). */
  onMerge: (fromSessionId: string, toSessionId: string) => void;
  /** Called when a session ends or goes silent (expire its pending decisions). */
  onSessionGone: (sessionId: string) => void;
  logger?: HubLogger;
  /** Process ancestry walker; injectable so tests can fake the process tree. */
  ancestry?: AncestryResolver;
  /** How long finished crew members linger (default CREW_GRACE_MS). */
  crewGraceMs?: number;
}

const ACTIVITY_THROTTLE_MS = 250;

export class SessionStore {
  private records = new Map<string, SessionRecord>();
  private throttles = new Map<string, { timer: Timer; lines: { line: string; at: string }[] }>();
  /** Last activity line per session, so heartbeats repeating it add nothing to history. */
  private lastLine = new Map<string, string>();
  private crewAsks = new Map<string, CrewAsk[]>();
  /** Main-thread Agent/Task calls not yet matched to their SubagentStart, per session, FIFO. */
  private spawns = new Map<string, { agentType: string; label: string; at: number }[]>();
  /** "<session>|<agent>" -> agent_transcript_path, when a hook has told us. */
  private agentTranscripts = new Map<string, string>();
  /** Last child-session status mirrored onto its parent, so we only re-emit the parent on change. */
  private mirroredStatus = new Map<string, SessionStatus>();
  /** "<session>|<agent>" -> teammate meta file contents (only cached once it names a team). */
  private teammateMetas = new Map<string, TeammateMeta>();
  /**
   * "<session>|<agent>" teammates removed from the bay, so the on-disk scan does not
   * put them straight back. Cleared by the agent's next hook.
   */
  private retired = new Set<string>();
  /** Agent team rosters under claudeHome, read-only, cached (see teams.ts). */
  readonly teams: TeamRoster;

  constructor(private deps: SessionStoreDeps) {
    this.teams = new TeamRoster(this.deps.config.claudeHome);
    const rows = this.deps.db
      .query<{ id: string; json: string }, []>("SELECT id, json FROM sessions")
      .all();
    const now = Date.now();
    for (const r of rows) {
      const rec = JSON.parse(r.json) as PersistedRecord;
      // Stale offline sessions stay in the db for history but never reach the UI.
      if (
        rec.session.status === "offline" &&
        now - Date.parse(rec.session.lastSeenAt) > this.deps.config.dropOfflineAfterMs
      ) {
        continue;
      }
      // A hub restart loses in-flight timers, so anything non-offline is suspect;
      // the sweep will flip it if it stays quiet.
      rec.session.crew ??= [];
      // Rows from before the engaged flag were all shown; keep showing them.
      rec.session.engaged ??= true;
      this.records.set(r.id, rec);
    }
  }

  // ─── read side ───────────────────────────────────────────────────────────

  get(id: string): Session | undefined {
    return this.records.get(id)?.session;
  }

  all(): Session[] {
    return [...this.records.values()].map((r) => r.session);
  }

  persona(id: string): Persona | undefined {
    return this.records.get(id)?.session.persona;
  }

  private liveNames(except?: string): string[] {
    return [...this.records.values()]
      .filter((r) => r.session.id !== except && r.session.status !== "offline")
      .map((r) => r.session.persona.name);
  }

  // ─── creation / correlation ──────────────────────────────────────────────

  ensure(
    id: string,
    init: {
      cwd?: string;
      transcriptPath?: string;
      claudePid?: number;
      provisional?: boolean;
      ancestorPids?: number[];
      /** Set before the record's first log line so even session_start is tagged as a child's. */
      parentSessionId?: string;
    } = {},
  ): SessionRecord {
    let rec = this.records.get(id);
    const now = new Date().toISOString();
    if (!rec) {
      const persona = this.deps.personas.getOrCreate(id, this.liveNames());
      const cwd = init.cwd ?? "";
      rec = {
        session: {
          id,
          persona,
          status: "working",
          cwd,
          project: projectLabel(cwd),
          ...(init.claudePid ? { claudePid: init.claudePid } : {}),
          ...(init.transcriptPath ? { transcriptPath: init.transcriptPath } : {}),
          ...(init.parentSessionId ? { parentSessionId: init.parentSessionId } : {}),
          startedAt: now,
          lastSeenAt: now,
          statusLine: phrase(persona.voice, persona.name, { kind: "session_start" }),
          stats: {
            toolCalls: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            decisionsAnswered: 0,
          },
          crew: [],
          engaged: false,
        },
        hookStatus: "working",
        ancestorPids: init.ancestorPids ?? [],
        provisional: init.provisional ?? false,
        metricsSeen: false,
      };
      this.records.set(id, rec);
      this.deps.log.add(persona, "session_start", rec.session.statusLine, {
        meta: { cwd, provisional: rec.provisional },
      });
      this.deps.logger?.info(
        "session",
        "online ",
        persona.name,
        shortPath(cwd),
        rec.provisional ? `(provisional ${id})` : undefined,
      );
      this.emitSession(rec);
      return rec;
    }
    let changed = false;
    if (init.cwd && init.cwd !== rec.session.cwd) {
      rec.session.cwd = init.cwd;
      rec.session.project = projectLabel(init.cwd);
      changed = true;
    }
    if (init.transcriptPath && init.transcriptPath !== rec.session.transcriptPath) {
      rec.session.transcriptPath = init.transcriptPath;
      changed = true;
    }
    if (init.claudePid && init.claudePid !== rec.session.claudePid) {
      rec.session.claudePid = init.claudePid;
      changed = true;
    }
    if (init.parentSessionId && !rec.session.parentSessionId) {
      rec.session.parentSessionId = init.parentSessionId;
      changed = true;
    }
    if (changed) this.emitSession(rec);
    return rec;
  }

  /**
   * Find the session an MCP call belongs to. The MCP server is a child of the
   * `claude` process, so its ancestor pid chain contains the pid hooks report
   * via X-Claude-Pid. If hooks are not wired (or have not fired yet) we fall
   * back to cwd, and failing that create a provisional `pid:<ppid>` session so
   * the decision still shows up on a station. When a hook later arrives from
   * that pid, `handleHook` merges the provisional session into the real one.
   */
  correlate(input: { sessionId?: string; ancestorPids?: number[]; cwd?: string }): SessionRecord {
    if (input.sessionId) {
      // MCP reported before any SessionStart hook linked it. ancestorPids[0] is
      // normally this session's own claude, which after /clear can still be a
      // live record under the old session id, so it never counts as a parent.
      const known = this.records.get(input.sessionId);
      const parent =
        !known?.session.parentSessionId && input.ancestorPids?.length
          ? this.findParent(input.ancestorPids.slice(1), input.sessionId, known?.session.claudePid)
          : undefined;
      const rec = this.ensure(input.sessionId, {
        cwd: input.cwd,
        parentSessionId: parent?.session.id,
      });
      if (parent) this.attachChild(rec, parent);
      return rec;
    }
    const pids = (input.ancestorPids ?? []).filter((p) => Number.isInteger(p) && p > 1);
    for (const pid of pids) {
      for (const rec of this.records.values()) {
        if (rec.session.status === "offline") continue;
        if (rec.session.claudePid === pid || rec.ancestorPids.includes(pid)) return rec;
      }
    }
    if (input.cwd) {
      const byCwd = [...this.records.values()].filter(
        (r) => r.session.status !== "offline" && r.session.cwd === input.cwd,
      );
      if (byCwd.length === 1) return byCwd[0] as SessionRecord;
    }
    const firstPid = pids[0];
    const id = firstPid ? `pid:${firstPid}` : `anon:${crypto.randomUUID().slice(0, 8)}`;
    return this.ensure(id, {
      cwd: input.cwd,
      provisional: true,
      ancestorPids: pids,
      claudePid: firstPid,
    });
  }

  /** Fold a provisional session into the real one once a hook reveals the session_id. */
  merge(fromId: string, toId: string) {
    const from = this.records.get(fromId);
    if (!from || fromId === toId) return;
    const existing = this.records.get(toId);
    let target: SessionRecord;
    if (!existing) {
      // Real session unseen so far: it simply inherits everything, persona included,
      // so the operator sees no change on the station.
      const persona =
        this.deps.personas.rekey(fromId, toId) ?? this.deps.personas.getOrCreate(toId, []);
      target = {
        ...from,
        session: { ...from.session, id: toId, persona },
        provisional: false,
        ancestorPids: [],
      };
    } else {
      // Both exist: keep whichever persona the operator saw first.
      const keepProvisional =
        Date.parse(from.session.startedAt) < Date.parse(existing.session.startedAt);
      const persona = keepProvisional
        ? (this.deps.personas.rekey(fromId, toId) ?? existing.session.persona)
        : existing.session.persona;
      target = existing;
      target.session.persona = persona;
      const a = target.session.stats;
      const b = from.session.stats;
      target.session.stats = {
        toolCalls: a.toolCalls + b.toolCalls,
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        costUsd: a.costUsd + b.costUsd,
        decisionsAnswered: a.decisionsAnswered + b.decisionsAnswered,
      };
      if (!target.session.cwd && from.session.cwd) {
        target.session.cwd = from.session.cwd;
        target.session.project = projectLabel(from.session.cwd);
      }
    }
    this.records.delete(fromId);
    this.deps.db.run("DELETE FROM sessions WHERE id = ?", [fromId]);
    this.records.set(toId, target);
    this.deps.logger?.info(
      "session",
      "merged ",
      target.session.persona.name,
      `${fromId} -> ${toId}`,
    );
    const engaged = from.session.engaged !== false;
    this.deps.log.reassign(fromId, toId, target.session.persona);
    if (engaged) this.engage(target);
    this.deps.onMerge(fromId, toId);
    this.deps.emit({ type: "session_removed", sessionId: fromId });
    this.refresh(toId);
  }

  // ─── hooks ───────────────────────────────────────────────────────────────

  handleHook(
    event: string,
    meta: HookMeta | number | undefined,
    payload: HookPayload,
  ): SessionRecord | undefined {
    const id = payload.session_id;
    if (!id || typeof id !== "string") return undefined;
    const { claudePid, parentPid, socket, token } =
      typeof meta === "number"
        ? { claudePid: meta, parentPid: undefined, socket: undefined, token: undefined }
        : (meta ?? {});

    if (claudePid) {
      for (const rec of [...this.records.values()]) {
        if (rec.provisional && rec.session.id !== id && rec.ancestorPids.includes(claudePid)) {
          this.merge(rec.session.id, id);
        }
      }
    }

    const parent =
      event === "SessionStart" && parentPid && !this.records.get(id)?.session.parentSessionId
        ? this.findParent((this.deps.ancestry ?? psAncestry)(parentPid), id, claudePid)
        : undefined;
    const rec = this.ensure(id, {
      parentSessionId: parent?.session.id,
      cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
      transcriptPath:
        typeof payload.transcript_path === "string" ? payload.transcript_path : undefined,
      claudePid,
    });
    const now = new Date().toISOString();
    rec.session.lastSeenAt = now;
    if (socket) rec.messagingSocket = socket;
    if (token) rec.messagingToken = token;
    const p = rec.session.persona;
    const say = (ev: VoiceEvent) => phrase(p.voice, p.name, ev);

    // A teammate between tasks: standby, handled with its other hooks below.
    const idleMate =
      event === "TeammateIdle" &&
      typeof payload.agent_id === "string" &&
      crewKind(payload.agent_id) === "teammate";
    // Other agent-team bookkeeping events: log only, never a status change.
    if (
      !idleMate &&
      (event === "TeammateIdle" || event === "TaskCreated" || event === "TaskCompleted")
    ) {
      this.logTeamEvent(rec, event, payload);
      return rec;
    }
    // Hooks fired inside a subagent or in-process teammate carry agent_id and
    // belong to that crew member, not to the main thread's status.
    if (typeof payload.agent_id === "string" && payload.agent_id) {
      this.handleCrewHook(rec, event, payload.agent_id, payload, now);
      return rec;
    }

    switch (event) {
      case "SessionStart": {
        this.setHookStatus(rec, "working");
        if (typeof payload.model === "string" && payload.model) rec.session.model = payload.model;
        rec.session.statusLine = say({ kind: "session_start" });
        if (parent) this.attachChild(rec, parent);
        this.emitSession(rec);
        break;
      }
      case "PermissionRequest": {
        // Fires the moment Claude Code would show a prompt; the permission_prompt
        // Notification only follows ~6s later, so this is the authoritative start.
        const tool = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
        const wasWaiting = rec.hookStatus === "waiting_permission";
        this.setHookStatus(rec, "waiting_permission", now);
        if (tool) rec.session.lastTool = tool;
        rec.session.statusLine = say({ kind: "permission_prompt", tool });
        if (!wasWaiting && !isQuestionTool(tool))
          this.deps.log.add(p, "permission_prompt", rec.session.statusLine, { meta: { tool } });
        this.emitSession(rec);
        break;
      }
      case "UserPromptSubmit": {
        this.engage(rec);
        this.setHookStatus(rec, "working");
        rec.session.statusLine = say({ kind: "prompt" });
        this.emitSession(rec);
        break;
      }
      case "PreToolUse":
      case "PostToolUse":
      case "PostToolUseFailure": {
        this.engage(rec);
        const tool = typeof payload.tool_name === "string" ? payload.tool_name : "tool";
        const wasBlocked = rec.hookStatus !== "working";
        this.setHookStatus(rec, "working");
        rec.session.lastTool = tool;
        // One history line per call: the start, with its target. Completion adds
        // a line only when the call failed.
        const target = toolTarget(tool, payload.tool_input, rec.session.cwd);
        let line: string | undefined;
        if (event === "PreToolUse") {
          rec.session.stats.toolCalls++;
          this.rememberSpawn(rec.session.id, tool, payload.tool_input);
          line = withTarget(say({ kind: "tool_start", tool }), target);
          rec.session.statusLine = line;
        } else if (event === "PostToolUseFailure") {
          line = withTarget(`✗ ${tool} failed`, target);
        }
        if (wasBlocked) this.emitSession(rec);
        this.emitActivity(rec, line);
        break;
      }
      case "Notification": {
        const type = payload.notification_type;
        if (type === "permission_prompt") {
          // Arrives ~6s after PermissionRequest; treat it as confirmation, not a new prompt.
          const tool = extractToolFromMessage(payload.message);
          const wasWaiting = rec.hookStatus === "waiting_permission";
          this.setHookStatus(rec, "waiting_permission", now);
          if (!wasWaiting) {
            rec.session.statusLine = say({ kind: "permission_prompt", tool });
            this.deps.log.add(p, "permission_prompt", rec.session.statusLine, {
              meta: { message: payload.message },
            });
          }
        } else if (type === "idle_prompt") {
          this.setHookStatus(rec, "idle", now);
          // With crew still out the session is not idle; derive() says so when they finish.
          if (!this.crewBusy(rec)) {
            rec.session.statusLine = say({ kind: "idle" });
            this.deps.log.add(p, "idle", rec.session.statusLine);
          }
        } else {
          this.deps.log.add(
            p,
            "note",
            typeof payload.message === "string" ? payload.message : String(type),
            {
              meta: { notification_type: type },
            },
          );
        }
        this.emitSession(rec);
        break;
      }
      case "Stop": {
        this.setHookStatus(rec, "idle", now);
        const line = say({ kind: "stop" });
        // The turn did end (history keeps it), but "awaiting orders" would be wrong on
        // a station whose crew is still working.
        if (!this.crewBusy(rec)) rec.session.statusLine = line;
        this.deps.log.add(p, "stop", line);
        this.emitSession(rec);
        break;
      }
      case "SubagentStop": {
        this.emitActivity(rec, say({ kind: "subagent_stop" }));
        break;
      }
      case "SessionEnd": {
        this.setHookStatus(rec, "offline");
        this.retireCrew(rec, now);
        rec.session.statusLine = say({ kind: "session_end" });
        this.deps.log.add(p, "session_end", rec.session.statusLine, {
          meta: { reason: payload.reason },
        });
        this.deps.logger?.info(
          "session",
          "offline",
          p.name,
          `reason=${String(payload.reason ?? "exit")}`,
        );
        this.deps.onSessionGone(rec.session.id);
        this.emitSession(rec);
        if (!rec.session.engaged) this.dropNoise(rec);
        break;
      }
      default: {
        // PreCompact, SubagentStart, etc: a heartbeat is all we need.
        this.emitActivity(rec, rec.session.statusLine);
      }
    }
    return rec;
  }

  // ─── crew ────────────────────────────────────────────────────────────────

  /**
   * A hook from inside a subagent or teammate. The parent's own status, lastTool
   * and statusLine are left alone (derive() keeps it "working" while crew is
   * busy), with one exception: a permission prompt raised by a crew member is
   * still a prompt in the parent's terminal, so the parent goes waiting_permission.
   */
  private handleCrewHook(
    rec: SessionRecord,
    event: string,
    agentId: string,
    payload: HookPayload,
    now: string,
  ) {
    const p = rec.session.persona;
    const say = (ev: VoiceEvent) => phrase(p.voice, p.name, ev);
    const role = crewRole(agentId, payload.agent_type);
    const label =
      crewKind(agentId) === "subagent" && !rec.session.crew.some((c) => c.id === agentId)
        ? this.claimSpawn(rec.session.id, payload.agent_type)
        : undefined;
    if (typeof payload.agent_transcript_path === "string" && payload.agent_transcript_path) {
      this.agentTranscripts.set(`${rec.session.id}|${agentId}`, payload.agent_transcript_path);
    }
    const who = { agentId, agentRole: role };
    const tool = typeof payload.tool_name === "string" ? payload.tool_name : undefined;

    if (event === "SubagentStop" || event === "Stop" || event === "TeammateIdle") {
      const m = this.upsertCrew(rec, agentId, role, now, false, label);
      if (m.kind === "teammate") {
        // Teammates stop after every task (SubagentStop, then TeammateIdle) and pick
        // up the next one later under the same agent_id, so they stay in the bay.
        if (m.status !== "standby") {
          m.status = "standby";
          delete m.endedAt;
          this.deps.logger?.debug("crew", "standby", p.name, m.role);
          this.emitSession(rec);
        }
        return;
      }
      m.status = "done";
      m.endedAt = now;
      const line = say({ kind: "subagent_stop" });
      this.deps.log.add(p, "note", `${role}: ${line}`, who);
      this.emitSession(rec);
      this.emitActivity(rec, line);
      return;
    }

    const before = rec.session.crew.find((c) => c.id === agentId)?.status;
    const m = this.upsertCrew(rec, agentId, role, now, true, label);
    let line: string | undefined;
    let sessionChanged = before !== m.status;

    switch (event) {
      case "PreToolUse": {
        m.toolCalls++;
        if (tool) m.lastTool = tool;
        if (isRequestDecisionTool(tool)) this.rememberCrewAsk(rec.session.id, who, payload);
        line = withTarget(
          say({ kind: "tool_start", tool: tool ?? "tool" }),
          tool ? toolTarget(tool, payload.tool_input, rec.session.cwd) : undefined,
        );
        break;
      }
      case "PostToolUse":
      case "PostToolUseFailure": {
        if (tool) m.lastTool = tool;
        if (isRequestDecisionTool(tool) && m.status === "waiting_decision") {
          m.status = "working";
          sessionChanged = true;
        }
        if (event === "PostToolUseFailure") {
          line = withTarget(
            `✗ ${tool ?? "tool"} failed`,
            tool ? toolTarget(tool, payload.tool_input, rec.session.cwd) : undefined,
          );
        }
        break;
      }
      case "PermissionRequest":
      case "Notification": {
        const isPrompt =
          event === "PermissionRequest" || payload.notification_type === "permission_prompt";
        if (!isPrompt) break;
        const wasWaiting = rec.hookStatus === "waiting_permission";
        this.setHookStatus(rec, "waiting_permission", now);
        rec.permissionAgentId = agentId;
        if (!wasWaiting) {
          rec.session.statusLine = `${role}: ${say({ kind: "permission_prompt", tool })}`;
        }
        if (!wasWaiting && !isQuestionTool(tool)) {
          this.deps.log.add(p, "permission_prompt", rec.session.statusLine, {
            ...who,
            meta: { tool },
          });
        }
        sessionChanged = true;
        break;
      }
      default:
      // SubagentStart and anything else: presence is all we record.
    }

    // The crew member that raised the prompt is running tools again, so it was answered.
    if (
      (event === "PreToolUse" || event === "PostToolUse" || event === "PostToolUseFailure") &&
      rec.hookStatus === "waiting_permission" &&
      rec.permissionAgentId === agentId
    ) {
      this.setHookStatus(rec, "working");
      rec.permissionAgentId = undefined;
      sessionChanged = true;
    }

    if (sessionChanged) this.emitSession(rec);
    this.emitActivity(rec, line ? `${role}: ${line}` : undefined);
  }

  /**
   * Creates the member on first sight (SubagentStart, or any hook after a hub
   * restart). `wake` puts a finished or standby member back on shift.
   */
  private upsertCrew(
    rec: SessionRecord,
    id: string,
    role: string,
    now: string,
    wake = true,
    label?: string,
  ): CrewMember {
    this.retired.delete(`${rec.session.id}|${id}`);
    let m = rec.session.crew.find((c) => c.id === id);
    if (!m) {
      const kind = crewKind(id);
      const meta = kind === "teammate" ? this.teammateMeta(rec.session.id, id) : undefined;
      m = {
        id,
        kind,
        role: meta?.name ?? role,
        ...(label ? { label } : {}),
        ...(meta?.teamName ? { team: meta.teamName } : {}),
        spriteSeed: hashString(`${rec.session.persona.spriteSeed}:${id}`),
        status: "working",
        startedAt: now,
        lastSeenAt: now,
        toolCalls: 0,
      };
      rec.session.crew.push(m);
      this.engage(rec);
      this.deps.log.add(rec.session.persona, "note", `${label ?? m.role} joined the crew.`, {
        agentId: id,
        agentRole: role,
        meta: { kind: m.kind },
      });
      return m;
    }
    m.lastSeenAt = now;
    if (role !== "subagent") m.role = role;
    if (wake && m.status === "done") {
      // Resumed (SendMessage to a finished agent): back on shift.
      m.status = "working";
      delete m.endedAt;
    } else if (wake && m.status === "standby") {
      m.status = "working";
      this.deps.logger?.debug("crew", "on shift", rec.session.persona.name, m.role);
    }
    return m;
  }

  /**
   * A main-thread Agent/Task call about to spawn a subagent. Calls that start a
   * teammate (team_name set) are skipped: teammates are named by their team.
   */
  private rememberSpawn(sessionId: string, tool: string, input: unknown) {
    if (!SPAWN_TOOLS.has(tool) || !input || typeof input !== "object") return;
    const i = input as { subagent_type?: unknown; team_name?: unknown };
    if (typeof i.team_name === "string" && i.team_name) return;
    const label = spawnLabel(input);
    if (!label) return;
    const now = Date.now();
    const list = (this.spawns.get(sessionId) ?? []).filter((s) => now - s.at < CREW_ASK_TTL_MS);
    const agentType =
      typeof i.subagent_type === "string" && i.subagent_type ? i.subagent_type : "general-purpose";
    list.push({ agentType, label, at: now });
    this.spawns.set(sessionId, list);
  }

  /** First unclaimed spawn of this agent_type (any, when the hook has none), FIFO. */
  private claimSpawn(sessionId: string, agentType: unknown): string | undefined {
    const now = Date.now();
    const list = (this.spawns.get(sessionId) ?? []).filter((s) => now - s.at < CREW_ASK_TTL_MS);
    const i = list.findIndex(
      (s) => typeof agentType !== "string" || !agentType || s.agentType === agentType,
    );
    const hit = i >= 0 ? list.splice(i, 1)[0] : undefined;
    if (list.length) this.spawns.set(sessionId, list);
    else this.spawns.delete(sessionId);
    return hit?.label;
  }

  /** The teammate's meta file (see teams.ts), cached once it names a team. */
  private teammateMeta(sessionId: string, agentId: string): TeammateMeta | undefined {
    const key = `${sessionId}|${agentId}`;
    const hit = this.teammateMetas.get(key);
    if (hit) return hit;
    const transcript = this.agentTranscript(sessionId, agentId);
    const meta = transcript ? readTeammateMeta(transcript) : undefined;
    if (meta?.teamName) this.teammateMetas.set(key, meta);
    return meta;
  }

  /**
   * The lead is gone (SessionEnd, or silent long enough to go offline): every
   * in-process crew member goes with it and fades out over the grace period.
   */
  private retireCrew(rec: SessionRecord, now: string) {
    let standby = 0;
    for (const m of rec.session.crew) {
      if (m.kind === "child_session" || m.status === "done") continue;
      if (m.status === "standby") standby++;
      m.status = "done";
      m.endedAt = now;
      this.retired.add(`${rec.session.id}|${m.id}`);
    }
    if (standby > 0) {
      this.deps.logger?.info(
        "crew",
        "removed",
        rec.session.persona.name,
        `${standby} teammate(s) on standby, lead ended`,
      );
    }
  }

  /**
   * Why a standby teammate is no longer on its team, or undefined while it is (or
   * we cannot tell). Joined on member name: roster ids ("<name>@<team>") never
   * match hook agent_ids ("a<name>-<hex>").
   */
  private offTeam(
    rec: SessionRecord,
    m: CrewMember,
    teams: Map<string, TeamInfo>,
  ): string | undefined {
    const meta = this.teammateMeta(rec.session.id, m.id);
    const name = meta?.name ?? teammateName(m.id) ?? m.role;
    const teamName = meta?.teamName ?? m.team;
    const team = teamName
      ? teams.get(teamName)
      : [...teams.values()].find((t) => t.leadSessionId === rec.session.id);
    if (!team) return teamName ? `team ${teamName} is gone` : undefined;
    return team.members.has(name) ? undefined : `no longer on team ${team.name}`;
  }

  /**
   * Teammates found on disk for this session but missing from the bay (hub
   * restarted or started mid-session) join on standby while their team still
   * lists them and their transcript moved within the standby window.
   */
  private seedTeammates(rec: SessionRecord, teams: Map<string, TeamInfo>, now: number): boolean {
    const transcript = rec.session.transcriptPath;
    if (!transcript) return false;
    let added = false;
    for (const t of listTeammates(transcript, rec.session.id)) {
      const key = `${rec.session.id}|${t.agentId}`;
      if (this.retired.has(key) || rec.session.crew.some((c) => c.id === t.agentId)) continue;
      if (now - t.lastActiveMs > this.deps.config.teammateStandbyMs) continue;
      if (!teams.get(t.teamName)?.members.has(t.name)) continue;
      const at = new Date(t.lastActiveMs).toISOString();
      rec.session.crew.push({
        id: t.agentId,
        kind: "teammate",
        role: t.name,
        team: t.teamName,
        spriteSeed: hashString(`${rec.session.persona.spriteSeed}:${t.agentId}`),
        status: "standby",
        startedAt: at,
        lastSeenAt: at,
        toolCalls: 0,
      });
      this.teammateMetas.set(key, { name: t.name, teamName: t.teamName });
      this.deps.logger?.debug("crew", "standby", rec.session.persona.name, `${t.name} (found)`);
      added = true;
    }
    return added;
  }

  private rememberCrewAsk(
    sessionId: string,
    who: { agentId: string; agentRole: string },
    payload: HookPayload,
  ) {
    const input = payload.tool_input as { question?: unknown } | undefined;
    if (typeof input?.question !== "string") return;
    const now = Date.now();
    const asks = (this.crewAsks.get(sessionId) ?? []).filter((a) => now - a.at < CREW_ASK_TTL_MS);
    asks.push({ ...who, question: input.question.trim(), at: now });
    this.crewAsks.set(sessionId, asks);
  }

  /**
   * A subagent's request_decision goes through the parent's MCP server, so the
   * POST only names the parent session. The PreToolUse hook for that call fired
   * just before it with agent_id and the same question: match on that.
   */
  claimCrewAsk(
    sessionId: string,
    question: string,
  ): { agentId: string; agentRole: string } | undefined {
    const now = Date.now();
    const asks = (this.crewAsks.get(sessionId) ?? []).filter((a) => now - a.at < CREW_ASK_TTL_MS);
    const i = asks.findIndex((a) => a.question === question.trim());
    const hit = i >= 0 ? asks.splice(i, 1)[0] : undefined;
    if (asks.length) this.crewAsks.set(sessionId, asks);
    else this.crewAsks.delete(sessionId);
    return hit ? { agentId: hit.agentId, agentRole: hit.agentRole } : undefined;
  }

  /** Flip a crew member in or out of waiting_decision as its decision opens or settles. */
  setCrewWaiting(sessionId: string, agentId: string, waiting: boolean) {
    const rec = this.records.get(sessionId);
    const m = rec?.session.crew.find((c) => c.id === agentId);
    if (!rec || !m || m.status === "done") return;
    // Settling a decision does not wake a teammate that has since gone on standby.
    if (!waiting && m.status === "standby") return;
    const next = waiting ? "waiting_decision" : "working";
    if (m.status === next) return;
    m.status = next;
    // Restart the stale clock: hours spent waiting on the operator are not silence.
    m.lastSeenAt = new Date().toISOString();
    this.emitSession(rec);
  }

  private logTeamEvent(rec: SessionRecord, event: string, payload: HookPayload) {
    const extra = payload as Record<string, unknown>;
    const detail = ["teammate_name", "task_subject", "task_id", "agent_type"]
      .map((k) => extra[k])
      .find((v): v is string => typeof v === "string" && v.length > 0);
    const agentId = typeof payload.agent_id === "string" ? payload.agent_id : undefined;
    this.deps.log.add(rec.session.persona, "note", detail ? `${event}: ${detail}` : event, {
      ...(agentId ? { agentId, agentRole: crewRole(agentId, payload.agent_type) } : {}),
      meta: { event },
    });
    this.emitActivity(rec, undefined);
  }

  /**
   * Nested `claude` processes get their own session_id and nothing in their env
   * points at the parent, but the process tree does. `pids` is an ancestor chain
   * that excludes the session's own claude; the nearest live session whose
   * claude pid is in it is the parent.
   */
  private findParent(
    pids: number[],
    selfId: string,
    selfClaudePid: number | undefined,
  ): SessionRecord | undefined {
    for (const pid of pids) {
      if (pid === selfClaudePid) continue;
      for (const other of this.records.values()) {
        if (
          other.session.id !== selfId &&
          !other.provisional &&
          other.hookStatus !== "offline" &&
          other.session.claudePid === pid &&
          other.session.parentSessionId !== selfId
        ) {
          return other;
        }
      }
    }
    return undefined;
  }

  /** Gives the parent a child_session crew slot; mirrorToParent keeps it current. */
  private attachChild(rec: SessionRecord, parent: SessionRecord) {
    if (parent.session.crew.some((c) => c.id === rec.session.id)) return;
    const now = new Date().toISOString();
    this.engage(parent);
    parent.session.crew.push({
      id: rec.session.id,
      kind: "child_session",
      role: "claude",
      spriteSeed: rec.session.persona.spriteSeed,
      status: "working",
      startedAt: now,
      lastSeenAt: now,
      toolCalls: rec.session.stats.toolCalls,
    });
    this.deps.log.add(
      parent.session.persona,
      "note",
      `Launched a nested session: ${rec.session.persona.name}.`,
      { agentId: rec.session.id, agentRole: "claude", meta: { childSessionId: rec.session.id } },
    );
    this.deps.logger?.info(
      "session",
      "child  ",
      rec.session.persona.name,
      `parent=${parent.session.persona.name}`,
    );
    this.emitSession(parent);
  }

  /**
   * Log entries written under a nested child session carry agentId = its id and
   * agentRole "claude" while its parent is live, so the UI files them under the
   * parent's crew instead of showing an operator with no station.
   */
  childTag(sessionId: string): { agentId: string; agentRole: string } | undefined {
    const parentId = this.records.get(sessionId)?.session.parentSessionId;
    const parent = parentId ? this.records.get(parentId) : undefined;
    if (!parent || parent.hookStatus === "offline") return undefined;
    return { agentId: sessionId, agentRole: "claude" };
  }

  /** Keep a child session's crew slot on its parent in step with the child's own status. */
  private mirrorToParent(rec: SessionRecord) {
    const parentId = rec.session.parentSessionId;
    const parent = parentId ? this.records.get(parentId) : undefined;
    const m = parent?.session.crew.find((c) => c.id === rec.session.id);
    if (!parent || !m) return;
    const s = rec.session;
    const next: CrewMember["status"] =
      s.status === "offline"
        ? "done"
        : s.status === "waiting_decision"
          ? "waiting_decision"
          : "working";
    const statusChanged = m.status !== next || this.mirroredStatus.get(s.id) !== s.status;
    this.mirroredStatus.set(s.id, s.status);
    const changed = statusChanged || m.toolCalls !== s.stats.toolCalls || m.lastTool !== s.lastTool;
    if (!changed) return;
    if (next === "done" && m.status !== "done") m.endedAt = s.lastSeenAt;
    if (next !== "done") delete m.endedAt;
    m.status = next;
    m.toolCalls = s.stats.toolCalls;
    if (s.lastTool) m.lastTool = s.lastTool;
    m.lastSeenAt = s.lastSeenAt;
    // Status flips can change the parent's derived status; tool churn only needs a throttled push.
    if (statusChanged) this.emitSession(parent);
    else this.emitActivity(parent, undefined);
  }

  /** Busy crew keeps an otherwise idle parent looking "working". */
  private crewBusy(rec: SessionRecord): boolean {
    return rec.session.crew.some((m) => {
      // Standby teammates are between tasks: the lead may go idle around them.
      if (m.status === "done" || m.status === "standby") return false;
      if (m.kind !== "child_session") return true;
      const child = this.records.get(m.id)?.session.status;
      return child === "working" || child === "waiting_decision" || child === "waiting_permission";
    });
  }

  /**
   * A crew member's own transcript. Hooks only give agent_transcript_path at
   * SubagentStop, so before that we use the layout observed on 2.1.280:
   * <dir of the session transcript>/<session id>/subagents/agent-<agent id>.jsonl
   */
  agentTranscript(sessionId: string, agentId: string): string | undefined {
    const known = this.agentTranscripts.get(`${sessionId}|${agentId}`);
    if (known) return known;
    const main = this.records.get(sessionId)?.session.transcriptPath;
    return main
      ? path.join(path.dirname(main), sessionId, "subagents", `agent-${agentId}.jsonl`)
      : undefined;
  }

  /** Where to deliver a message into the live session, if we know. */
  messaging(id: string): { socket?: string; token?: string } {
    const rec = this.records.get(id);
    return { socket: rec?.messagingSocket, token: rec?.messagingToken };
  }

  // ─── engagement ──────────────────────────────────────────────────────────

  /**
   * A session is noise until it shows real work: a prompt, a main-thread tool
   * call, a crew member or a decision. Until then the UI hides it and its log
   * lines are held (see LogStore.holdFor); engaging releases them in order.
   */
  engage(rec: SessionRecord | string) {
    const r = typeof rec === "string" ? this.records.get(rec) : rec;
    if (!r || r.session.engaged) return;
    r.session.engaged = true;
    this.deps.log.release(r.session.id);
    this.emitSession(r);
  }

  isHeld(id: string): boolean {
    return this.records.get(id)?.session.engaged === false;
  }

  /** Ended (or went silent) without engaging: forget it completely. */
  private dropNoise(rec: SessionRecord) {
    const id = rec.session.id;
    this.records.delete(id);
    this.deps.db.run("DELETE FROM sessions WHERE id = ?", [id]);
    this.deps.log.discard(id);
    this.deps.personas.forget(id);
    this.mirroredStatus.delete(id);
    this.lastLine.delete(id);
    const parent = rec.session.parentSessionId
      ? this.records.get(rec.session.parentSessionId)
      : undefined;
    if (parent) {
      parent.session.crew = parent.session.crew.filter((m) => m.id !== id);
      this.emitSession(parent);
    }
    this.deps.logger?.info("session", "dropped", rec.session.persona.name, "(never engaged)");
    this.deps.emit({ type: "session_removed", sessionId: id });
  }

  // ─── other inputs ────────────────────────────────────────────────────────

  /** Agent-authored narration via the MCP report_status tool. */
  setStatusLine(id: string, line: string) {
    const rec = this.records.get(id);
    if (!rec) return;
    rec.session.lastSeenAt = new Date().toISOString();
    rec.session.statusLine = line;
    this.emitActivity(rec, line);
  }

  /** Soft signals from OTLP; never override a permission wait except when Claude is provably running again. */
  otlpActivity(
    id: string,
    input: { tool?: string; model?: string; resumesWork?: boolean; line?: string },
  ) {
    const rec = this.records.get(id) ?? this.ensure(id);
    rec.session.lastSeenAt = new Date().toISOString();
    if (input.tool) rec.session.lastTool = input.tool;
    if (input.model) rec.session.model = input.model;
    if (input.resumesWork && rec.hookStatus !== "working" && rec.hookStatus !== "offline") {
      this.setHookStatus(rec, "working");
      this.emitSession(rec);
    }
    if (input.line) rec.session.statusLine = input.line;
    this.emitActivity(rec, rec.session.statusLine);
  }

  addUsage(
    id: string,
    usage: { inputTokens?: number; outputTokens?: number; costUsd?: number; fromMetrics: boolean },
  ) {
    const rec = this.records.get(id) ?? this.ensure(id);
    if (usage.fromMetrics) rec.metricsSeen = true;
    else if (rec.metricsSeen) return;
    rec.session.stats.inputTokens += usage.inputTokens ?? 0;
    rec.session.stats.outputTokens += usage.outputTokens ?? 0;
    rec.session.stats.costUsd += usage.costUsd ?? 0;
    this.emitActivity(rec, rec.session.statusLine);
  }

  bumpDecisionsAnswered(id: string) {
    const rec = this.records.get(id);
    if (rec) rec.session.stats.decisionsAnswered++;
  }

  /** Re-derive status (pending decisions may have changed) and broadcast. */
  refresh(id: string) {
    const rec = this.records.get(id);
    if (rec) this.emitSession(rec);
  }

  /** Called on a timer: flip silent sessions offline, drop ancient ones. */
  sweep(now = Date.now()) {
    const grace = this.deps.crewGraceMs ?? CREW_GRACE_MS;
    const teams = this.teams.teams(now);
    for (const rec of [...this.records.values()]) {
      let crewChanged = rec.hookStatus !== "offline" && this.reconcileTeammates(rec, teams, now);
      for (const m of rec.session.crew) {
        // A subagent killed without SubagentStop would otherwise pin its parent to "working".
        // One stuck in a single long tool call gets marked done too; its next hook
        // puts it back on shift (upsertCrew). Waiting on a decision is not silence.
        if (
          m.kind !== "child_session" &&
          m.status === "working" &&
          now - Date.parse(m.lastSeenAt) > this.deps.config.crewStaleMs
        ) {
          m.status = "done";
          m.endedAt = new Date(now).toISOString();
          crewChanged = true;
          this.deps.logger?.info(
            "crew",
            "stale  ",
            rec.session.persona.name,
            `${m.role} silent since ${m.lastSeenAt}, marked done`,
          );
        }
      }
      const kept = rec.session.crew.filter(
        (m) => !(m.status === "done" && m.endedAt && now - Date.parse(m.endedAt) > grace),
      );
      if (kept.length !== rec.session.crew.length) {
        rec.session.crew = kept;
        crewChanged = true;
      }
      if (crewChanged) this.emitSession(rec);
      const silentFor = now - Date.parse(rec.session.lastSeenAt);
      if (
        rec.hookStatus !== "offline" &&
        silentFor > this.deps.config.offlineAfterMs &&
        !rec.session.engaged
      ) {
        this.dropNoise(rec);
      } else if (rec.hookStatus !== "offline" && silentFor > this.deps.config.offlineAfterMs) {
        const p = rec.session.persona;
        this.setHookStatus(rec, "offline");
        this.retireCrew(rec, new Date(now).toISOString());
        rec.session.statusLine = phrase(p.voice, p.name, { kind: "lost_signal" });
        this.deps.log.add(p, "session_end", rec.session.statusLine, {
          meta: { reason: "silence" },
        });
        this.deps.logger?.info("session", "offline", p.name, "reason=silence");
        this.deps.onSessionGone(rec.session.id);
        this.emitSession(rec);
      } else if (rec.hookStatus === "offline" && silentFor > this.deps.config.dropOfflineAfterMs) {
        this.records.delete(rec.session.id);
        this.lastLine.delete(rec.session.id);
        this.deps.emit({ type: "session_removed", sessionId: rec.session.id });
      }
    }
  }

  /**
   * Standby teammates leave the bay when their team no longer lists them (or the
   * team is gone) or after teammateStandbyMs of silence; missing ones are seeded.
   * Working and waiting teammates are left to their hooks and the stale rule.
   */
  private reconcileTeammates(
    rec: SessionRecord,
    teams: Map<string, TeamInfo> | undefined,
    now: number,
  ): boolean {
    let changed = teams ? this.seedTeammates(rec, teams, now) : false;
    const kept = rec.session.crew.filter((m) => {
      if (m.kind !== "teammate" || m.status !== "standby") return true;
      const reason =
        (teams && this.offTeam(rec, m, teams)) ??
        (now - Date.parse(m.lastSeenAt) > this.deps.config.teammateStandbyMs
          ? `silent since ${m.lastSeenAt}`
          : undefined);
      if (!reason) return true;
      this.retired.add(`${rec.session.id}|${m.id}`);
      this.deps.logger?.info("crew", "removed", rec.session.persona.name, `${m.role} ${reason}`);
      return false;
    });
    if (kept.length !== rec.session.crew.length) {
      rec.session.crew = kept;
      changed = true;
    }
    return changed;
  }

  dispose() {
    for (const t of this.throttles.values()) clearTimeout(t.timer);
    this.throttles.clear();
  }

  // ─── internals ───────────────────────────────────────────────────────────

  /** Entering a blocking state stamps blockedSince; staying in it keeps the original stamp. */
  private setHookStatus(rec: SessionRecord, status: SessionStatus, blockedSince?: string) {
    const changed = rec.hookStatus !== status;
    rec.hookStatus = status;
    if (status !== "idle") rec.idleHeldByCrew = false;
    if (status === "working" || status === "offline") {
      rec.hookBlockedSince = undefined;
    } else if (changed || !rec.hookBlockedSince) {
      rec.hookBlockedSince = blockedSince ?? new Date().toISOString();
    }
  }

  private derive(rec: SessionRecord) {
    rec.session.canMessage =
      rec.hookStatus !== "offline" &&
      this.deps.config.socketReply &&
      socketExists(rec.messagingSocket);
    const pending = rec.hookStatus === "offline" ? [] : this.deps.pendingFor(rec.session.id);
    if (pending.length > 0) {
      rec.session.status = "waiting_decision";
      rec.session.blockedSince = pending.map((d) => d.createdAt).sort()[0];
    } else if (rec.hookStatus === "idle" && this.crewBusy(rec)) {
      // Main thread ended its turn but subagents / teammates are still running.
      rec.session.status = "working";
      delete rec.session.blockedSince;
      rec.idleHeldByCrew = true;
    } else {
      if (rec.hookStatus === "idle" && rec.idleHeldByCrew) this.releaseCrewHold(rec);
      rec.session.status = rec.hookStatus;
      if (rec.hookBlockedSince) rec.session.blockedSince = rec.hookBlockedSince;
      else delete rec.session.blockedSince;
    }
  }

  /**
   * The last busy crew member just finished while the main thread sat idle: the
   * session goes idle now, so the idle clock starts here rather than at the
   * main thread's earlier Stop / idle_prompt.
   */
  private releaseCrewHold(rec: SessionRecord) {
    rec.idleHeldByCrew = false;
    rec.hookBlockedSince = new Date().toISOString();
    const p = rec.session.persona;
    rec.session.statusLine = phrase(p.voice, p.name, { kind: "idle" });
    this.deps.log.add(p, "idle", rec.session.statusLine);
    this.deps.logger?.info("session", "idle   ", p.name, "crew done");
  }

  private persist(rec: SessionRecord) {
    const persisted: PersistedRecord = { ...rec };
    this.deps.db.run("INSERT OR REPLACE INTO sessions (id, json, updated_at) VALUES (?, ?, ?)", [
      rec.session.id,
      JSON.stringify(persisted),
      new Date().toISOString(),
    ]);
  }

  private emitSession(rec: SessionRecord) {
    this.derive(rec);
    this.persist(rec);
    this.deps.emit({ type: "session", session: rec.session });
    this.mirrorToParent(rec);
  }

  /**
   * Tool churn can be tens of events a second across sessions. We coalesce to
   * one session + one activity event per 250ms per session (trailing edge) so
   * the UI always ends up with the latest line without drowning. A trailing
   * edge with no line pushes the session only (crew counters changed).
   */
  private emitActivity(rec: SessionRecord, line: string | undefined) {
    const id = rec.session.id;
    const at = new Date().toISOString();
    const fresh = line !== undefined && line !== this.lastLine.get(id);
    if (fresh) this.lastLine.set(id, line);
    const existing = this.throttles.get(id);
    if (existing) {
      if (fresh) existing.lines.push({ line, at });
      return;
    }
    const timer = setTimeout(() => {
      const t = this.throttles.get(id);
      this.throttles.delete(id);
      const current = this.records.get(id);
      if (!current || !t) return;
      this.derive(current);
      this.persist(current);
      this.deps.emit({ type: "session", session: current.session });
      // Every distinct line goes out (history wants them all); only the session
      // snapshot is coalesced.
      for (const l of t.lines) {
        this.deps.emit({ type: "activity", sessionId: id, line: l.line, at: l.at });
      }
      this.mirrorToParent(current);
    }, ACTIVITY_THROTTLE_MS);
    timer.unref?.();
    this.throttles.set(id, { timer, lines: fresh ? [{ line, at }] : [] });
  }
}

export function projectLabel(cwd: string): string {
  if (!cwd) return "unknown";
  return path.basename(cwd) || cwd;
}

/** Notification messages look like "Claude needs your permission to use Bash". */
function extractToolFromMessage(message: unknown): string | undefined {
  if (typeof message !== "string") return undefined;
  const m = message.match(/permission to use (\S+)/i);
  return m?.[1];
}
