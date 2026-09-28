import type { CrewMember } from "@amc/shared";
import { teammateName } from "./teams";

/** Finished crew members stay visible this long so the bay does not flicker. */
export const CREW_GRACE_MS = 60_000;
/** A crew member's PreToolUse(request_decision) is matched to the POST that follows within this window. */
export const CREW_ASK_TTL_MS = 30_000;

/**
 * Subagents and in-process teammates share the parent's session_id and differ
 * only in `agent_id`. Observed on 2.1.280: Task-tool subagents get "a" + 16 hex
 * chars ("a098142c5545132d2"); teammates get "a" + their name + "-" + suffix
 * ("ainvestigator-..."). Anything that is not the hex shape is treated as a
 * teammate, which is the safer mislabel (a teammate label on a subagent is
 * cosmetic; the reverse hides a named agent).
 */
export function crewKind(agentId: string): "subagent" | "teammate" {
  return /^a[0-9a-f]{16}$/i.test(agentId) ? "subagent" : "teammate";
}

/**
 * Teammates are labelled by their team member name (embedded in the id, and what
 * the team roster lists); everyone else by agent_type, else a generic label.
 */
export function crewRole(agentId: string, agentType: unknown): string {
  if (crewKind(agentId) === "teammate") {
    const name = teammateName(agentId);
    if (name) return name;
  }
  if (typeof agentType === "string" && agentType.trim()) return agentType.trim();
  return "subagent";
}

/** Main-thread tools that spawn a subagent. */
export const SPAWN_TOOLS = new Set(["Agent", "Task"]);
const LABEL_MAX = 16;

/**
 * What to call a subagent in the bay: the spawning call's `name`, else its
 * `description` cut at a word boundary to ~16 chars. Hooks inside the subagent
 * only carry agent_type ("general-purpose"), which says nothing.
 */
export function spawnLabel(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const { name, description } = input as { name?: unknown; description?: unknown };
  if (typeof name === "string" && name.trim()) return name.trim().slice(0, LABEL_MAX);
  if (typeof description !== "string") return undefined;
  const d = description.trim().replace(/\s+/g, " ");
  if (!d) return undefined;
  if (d.length <= LABEL_MAX) return d;
  const cut = d.lastIndexOf(" ", LABEL_MAX);
  return (cut >= 8 ? d.slice(0, cut) : d.slice(0, LABEL_MAX)).trim();
}

export function isRequestDecisionTool(tool: unknown): boolean {
  return typeof tool === "string" && tool.endsWith("__request_decision");
}

/** Returns [pid, ppid, grandparent, ...], at most `depth` entries, stopping at init. */
export type AncestryResolver = (pid: number) => number[];

const PPID_CACHE_MS = 60_000;
const ppidCache = new Map<number, { ppid: number; at: number }>();

function ppidOf(pid: number): number | undefined {
  const hit = ppidCache.get(pid);
  const now = Date.now();
  if (hit && now - hit.at < PPID_CACHE_MS) return hit.ppid;
  try {
    const out = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)])
      .stdout.toString()
      .trim();
    const ppid = Number.parseInt(out, 10);
    if (!Number.isInteger(ppid)) return undefined;
    ppidCache.set(pid, { ppid, at: now });
    return ppid;
  } catch {
    return undefined;
  }
}

/**
 * Walks `ps` upward from a pid. Used once per SessionStart to find out whether a
 * new `claude` was started underneath another live session (nothing in its env
 * links the two; the process tree does: child claude -> shell -> parent claude).
 */
export function psAncestry(pid: number, depth = 8): number[] {
  const out: number[] = [];
  let cur = pid;
  for (let i = 0; i < depth && cur > 1; i++) {
    out.push(cur);
    const next = ppidOf(cur);
    if (next === undefined || next <= 1) break;
    cur = next;
  }
  return out;
}
