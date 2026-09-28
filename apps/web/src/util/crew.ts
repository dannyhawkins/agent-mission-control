import type { CrewMember, Decision, Session } from "@amc/shared";
import { lighten, PERSONA_HEX } from "./theme";

/** How far toward white crew sprites and role tags sit from the parent persona colour. */
const CREW_LIGHTEN = 0.45;

export function crewTint(parent: Session["persona"]["color"]): string {
  return lighten(PERSONA_HEX[parent], CREW_LIGHTEN);
}

/** Hubs older than the crew feature send sessions without `crew`. */
export function crewOf(s: Session): CrewMember[] {
  return s.crew ?? [];
}

/**
 * Someone in the bay is still on shift (working, or waiting on a decision). Standby teammates
 * (between tasks) and finished crew are not.
 */
export function crewBusy(s: Session): boolean {
  return crewOf(s).some((m) => m.status === "working" || m.status === "waiting_decision");
}

/**
 * READY: finished its turn, nothing pending, and no crew still out. The hub already reports a
 * session with busy crew as "working"; checking here too keeps the badge, idle chime and the
 * "standing by" line honest against an older hub or a snapshot caught mid-update.
 */
export function isReady(s: Session, decisions: readonly Decision[]): boolean {
  return s.status === "idle" && decisions.length === 0 && !crewBusy(s);
}

const ROLE_ALIAS: Record<string, string> = {
  "general-purpose": "GENERAL",
  child_session: "CLAUDE",
};

const GENERIC_SUFFIX = new Set(["crew", "agent", "bot", "team", "worker", "helper", "purpose"]);

/**
 * Bay labels are 7px pixel type under a 16px sprite, so roles must be short.
 * "plugin:code-reviewer" -> "REVIEWER", "general-purpose" -> "GENERAL"; the tooltip has the full role.
 */
export function shortRole(role: string): string {
  const alias = ROLE_ALIAS[role.toLowerCase()];
  if (alias) return alias;
  const last = role.split(/[:/]/).pop() ?? role;
  // The last hyphen segment is usually the distinctive one (code-reviewer -> REVIEWER), except
  // for team-style names where it is the generic noun: frontend-crew and backend-crew must not
  // both collapse to CREW.
  const parts = last.split("-").filter(Boolean);
  let pick = parts[parts.length - 1] ?? last;
  if (parts.length > 1 && GENERIC_SUFFIX.has(pick.toLowerCase()))
    pick = parts[parts.length - 2] ?? pick;
  return pick.toUpperCase().slice(0, 8);
}

/** FNV-1a, for a stable sprite when a decision or log line names an agent the bay no longer lists. */
export function seedFrom(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function childStatus(s: Session): CrewMember["status"] {
  if (s.status === "offline") return "done";
  if (s.status === "waiting_decision" || s.status === "waiting_permission") {
    return "waiting_decision";
  }
  return "working";
}

export interface FloorView {
  /** Sessions that get their own station (live, and not folded into a live parent). */
  stations: Session[];
  /** Ended sessions for the off-shift strip. Folded children never appear here. */
  offShift: Session[];
  /** Station id -> pending decisions, with child-session decisions rerouted to the parent. */
  decisions: Record<string, Decision[]>;
}

/**
 * Folds nested `claude` sessions into their parent's crew bay. A child only folds while its
 * parent is live; an orphan renders as a normal station. The hub is expected to list the child
 * in the parent's `crew` as kind child_session, but if it has not (older hub, race on
 * SessionStart) we synthesise the member here so the child never silently disappears.
 * Decisions a folded child raises move to the parent station, tagged with the child as agent.
 */
export function floorView(all: Session[], decisions: Decision[]): FloorView {
  // engaged === false: a claude process nobody is working in (background helpers, one-shot -p
  // runs the hub decided are noise). Hidden everywhere; undefined means engaged.
  const sessions = all.filter((s) => s.engaged !== false);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const folded = new Map<string, Session>(); // child id -> parent
  for (const s of sessions) {
    const parent = s.parentSessionId ? byId.get(s.parentSessionId) : undefined;
    if (parent && parent.status !== "offline" && !parent.parentSessionId) folded.set(s.id, parent);
  }

  const extraCrew = new Map<string, CrewMember[]>();
  for (const [childId, parent] of folded) {
    if (crewOf(parent).some((m) => m.id === childId)) continue;
    const child = byId.get(childId);
    if (!child) continue;
    const list = extraCrew.get(parent.id) ?? [];
    list.push({
      id: child.id,
      kind: "child_session",
      role: "child_session",
      spriteSeed: child.persona.spriteSeed,
      status: childStatus(child),
      startedAt: child.startedAt,
      lastSeenAt: child.lastSeenAt,
      lastTool: child.lastTool,
      toolCalls: child.stats.toolCalls,
    });
    extraCrew.set(parent.id, list);
  }

  const stations: Session[] = [];
  const offShift: Session[] = [];
  for (const s of sessions) {
    if (folded.has(s.id)) continue;
    if (s.status === "offline") {
      offShift.push(s);
      continue;
    }
    const extra = extraCrew.get(s.id);
    stations.push(extra ? { ...s, crew: [...crewOf(s), ...extra] } : s);
  }

  const out: Record<string, Decision[]> = {};
  for (const d of decisions) {
    const parent = folded.get(d.sessionId);
    const routed: Decision = parent
      ? {
          ...d,
          sessionId: parent.id,
          agentId: d.agentId ?? d.sessionId,
          agentRole: d.agentRole ?? "child_session",
        }
      : d;
    const list = out[routed.sessionId] ?? [];
    list.push(routed);
    out[routed.sessionId] = list;
  }
  return { stations, offShift, decisions: out };
}

/**
 * Crew activity lines arrive as "Role: text". Returns the member and the split when the prefix
 * names someone in the bay, so the ticker can tint just the prefix.
 */
export function splitRolePrefix(
  line: string,
  crew: CrewMember[],
): { member: CrewMember; prefix: string; rest: string } | undefined {
  if (crew.length === 0) return undefined;
  const m = /^([\w .:/-]{1,40}?): /.exec(line);
  const said = m?.[1];
  if (!m || !said) return undefined;
  const member = crew.find(
    (c) => c.role.toLowerCase() === said.toLowerCase() || shortRole(c.role) === said.toUpperCase(),
  );
  if (!member) return undefined;
  return { member, prefix: m[0], rest: line.slice(m[0].length) };
}
