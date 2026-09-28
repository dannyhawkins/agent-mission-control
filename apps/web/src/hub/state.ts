import type { Decision, LogEntry, ServerEvent, Session } from "@amc/shared";

export interface ActivityLine {
  at: string;
  line: string;
}

export interface HubState {
  sessions: Record<string, Session>;
  /** Pending decisions only. Any other status removes the entry. */
  decisions: Record<string, Decision>;
  /** Newest last, capped. */
  log: LogEntry[];
  /** sessionId -> last activity timestamp (ms). Drives the signal-bar pulse. Not persisted. */
  activity: Record<string, number>;
  /** sessionId -> last few activity lines (newest last). Shown as a scrollback on quiet stations. */
  recent: Record<string, ActivityLine[]>;
  /** True once a snapshot has been applied; gates "empty floor" vs "still loading". */
  hydrated: boolean;
  /**
   * Bumped on every snapshot (first load and each reconnect). A snapshot is a resync, not news:
   * anything diffing state for announcements reseeds silently when this changes.
   */
  snapshots: number;
}

export const initialState: HubState = {
  sessions: {},
  decisions: {},
  log: [],
  activity: {},
  recent: {},
  hydrated: false,
  snapshots: 0,
};

const LOG_CAP = 500;
// Enough to fill a focused, full-height station; the list clips to its box and the
// newest lines sit at the bottom, so extra lines cost nothing visually.
const RECENT_CAP = 80;

/**
 * Merge rules:
 *  - snapshot replaces sessions/decisions/log wholesale (it is authoritative on connect and reconnect),
 *    and seeds scrollback from `recentActivity` when the hub sends it (older hubs do not).
 *  - session upserts; session_removed also drops that session's pending decisions, scrollback
 *    and activity timestamp, so a long-lived tab does not accumulate dead sessions.
 *  - decision upserts while pending and deletes otherwise, so the map is always "what needs an answer".
 *  - log appends, deduped by id (a reconnect snapshot plus a late push can overlap).
 *  - activity is high-frequency and only touches statusLine/lastSeenAt plus the pulse timestamp.
 */
export function reduce(state: HubState, ev: ServerEvent): HubState {
  switch (ev.type) {
    case "snapshot": {
      const sessions: Record<string, Session> = {};
      for (const s of ev.state.sessions) sessions[s.id] = s;
      const decisions: Record<string, Decision> = {};
      for (const d of ev.state.decisions) if (d.status === "pending") decisions[d.id] = d;
      // Sessions that vanished while we were disconnected take their per-session caches with them.
      const keep = (m: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(m).filter(([id]) => id in sessions));
      return {
        ...state,
        sessions,
        decisions,
        log: ev.state.log.slice(-LOG_CAP),
        activity: keep(state.activity) as HubState["activity"],
        recent: ev.state.recentActivity
          ? Object.fromEntries(
              Object.entries(ev.state.recentActivity)
                .filter(([id]) => id in sessions)
                .map(([id, lines]) => [id, lines.slice(-RECENT_CAP)]),
            )
          : (keep(state.recent) as HubState["recent"]),
        hydrated: true,
        snapshots: state.snapshots + 1,
      };
    }
    case "session":
      return { ...state, sessions: { ...state.sessions, [ev.session.id]: ev.session } };
    case "session_removed": {
      const sessions = { ...state.sessions };
      delete sessions[ev.sessionId];
      const decisions = Object.fromEntries(
        Object.entries(state.decisions).filter(([, d]) => d.sessionId !== ev.sessionId),
      );
      const recent = { ...state.recent };
      delete recent[ev.sessionId];
      const activity = { ...state.activity };
      delete activity[ev.sessionId];
      return { ...state, sessions, decisions, recent, activity };
    }
    case "decision": {
      if (ev.decision.status === "pending") {
        return { ...state, decisions: { ...state.decisions, [ev.decision.id]: ev.decision } };
      }
      if (!(ev.decision.id in state.decisions)) return state;
      const decisions = { ...state.decisions };
      delete decisions[ev.decision.id];
      return { ...state, decisions };
    }
    case "log": {
      if (state.log.some((e) => e.id === ev.entry.id)) return state;
      const log = [...state.log, ev.entry];
      return { ...state, log: log.length > LOG_CAP ? log.slice(-LOG_CAP) : log };
    }
    case "activity": {
      const s = state.sessions[ev.sessionId];
      const sessions = s
        ? { ...state.sessions, [ev.sessionId]: { ...s, statusLine: ev.line, lastSeenAt: ev.at } }
        : state.sessions;
      const at = Date.parse(ev.at);
      const recent = [...(state.recent[ev.sessionId] ?? []), { at: ev.at, line: ev.line }].slice(
        -RECENT_CAP,
      );
      return {
        ...state,
        sessions,
        activity: { ...state.activity, [ev.sessionId]: Number.isNaN(at) ? Date.now() : at },
        recent: { ...state.recent, [ev.sessionId]: recent },
      };
    }
  }
}
