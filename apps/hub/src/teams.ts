import fs from "node:fs";
import path from "node:path";

/**
 * Read-only view of Claude Code agent teams, for keeping teammates on standby
 * exactly as long as they are still on their team (#19).
 *
 * Observed on 2.1.281, and the reason the lookup goes through the meta file
 * rather than the roster alone:
 *
 * - <claudeHome>/teams/<team>/config.json holds {name, leadSessionId, members:
 *   [{agentId: "<name>@<team>", name, agentType, ...}]}. The lead is a member too
 *   (name "team-lead").
 * - Hooks fired inside a teammate carry agent_id "a<name>-<16 hex>", which never
 *   appears in the roster. The two join on the member name.
 * - leadSessionId is not reliably the lead's current session_id (a team created
 *   in one session keeps it after the lead is resumed under a new id), so it is
 *   only a fallback.
 * - Each teammate has <session transcript dir>/<session id>/subagents/
 *   agent-<agent_id>.meta.json with {name, teamName, taskKind:
 *   "in_process_teammate", ...}. That is the reliable agent_id -> team link.
 */

export interface TeamInfo {
  name: string;
  leadSessionId?: string;
  /** Member names, lead included. */
  members: Set<string>;
}

export interface TeammateMeta {
  name?: string;
  teamName?: string;
}

/** "athread-inventory-8caab213f214beb8" -> "thread-inventory". */
export function teammateName(agentId: string): string | undefined {
  return agentId.match(/^a(.+)-[0-9a-f]{4,}$/i)?.[1];
}

const ROSTER_TTL_MS = 30_000;

export class TeamRoster {
  private cache?: { at: number; teams: Map<string, TeamInfo> | undefined };
  /** Last good parse per team, so a config caught mid-write does not look like a disband. */
  private lastGood = new Map<string, TeamInfo>();

  constructor(
    private claudeHome: string,
    private ttlMs = ROSTER_TTL_MS,
  ) {}

  /** Forget the cached scan (tests, or after something is known to have changed). */
  invalidate() {
    this.cache = undefined;
  }

  /**
   * All teams by name, cached for ttlMs. undefined when the teams dir cannot be
   * read at all, which callers must treat as "unknown", never as "every team is gone".
   */
  teams(now = Date.now()): Map<string, TeamInfo> | undefined {
    if (this.cache && Math.abs(now - this.cache.at) < this.ttlMs) return this.cache.teams;
    const teams = this.scan();
    this.cache = { at: now, teams };
    return teams;
  }

  private scan(): Map<string, TeamInfo> | undefined {
    const dir = path.join(this.claudeHome, "teams");
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return undefined;
    }
    const out = new Map<string, TeamInfo>();
    for (const n of names) {
      const file = path.join(dir, n, "config.json");
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue; // not a team dir, or deleted between readdir and read
      }
      try {
        const cfg = JSON.parse(raw) as {
          name?: unknown;
          leadSessionId?: unknown;
          members?: { name?: unknown }[];
        };
        const info: TeamInfo = {
          name: typeof cfg.name === "string" ? cfg.name : n,
          leadSessionId: typeof cfg.leadSessionId === "string" ? cfg.leadSessionId : undefined,
          members: new Set(
            (Array.isArray(cfg.members) ? cfg.members : [])
              .map((m) => m?.name)
              .filter((x): x is string => typeof x === "string"),
          ),
        };
        this.lastGood.set(n, info);
        out.set(n, info);
      } catch {
        const prev = this.lastGood.get(n);
        if (prev) out.set(n, prev);
      }
    }
    return out;
  }
}

/** agent-<id>.jsonl -> agent-<id>.meta.json, parsed; undefined when absent or unreadable. */
export function readTeammateMeta(agentTranscript: string): TeammateMeta | undefined {
  const file = agentTranscript.replace(/\.jsonl$/, ".meta.json");
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      name: typeof m.name === "string" ? m.name : undefined,
      teamName: typeof m.teamName === "string" ? m.teamName : undefined,
    };
  } catch {
    return undefined;
  }
}

export interface SeenTeammate {
  agentId: string;
  name: string;
  teamName: string;
  /** mtime of the teammate's transcript: its last sign of life. */
  lastActiveMs: number;
}

/**
 * Teammates of a session found on disk (subagents/*.meta.json with taskKind
 * in_process_teammate). Used to put a team back in the bay after a hub restart
 * or when the hub started mid-session. Hex-id Task subagents are skipped by name
 * so a directory of hundreds of them costs one readdir.
 */
export function listTeammates(sessionTranscript: string, sessionId: string): SeenTeammate[] {
  const dir = path.join(path.dirname(sessionTranscript), sessionId, "subagents");
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SeenTeammate[] = [];
  for (const f of files) {
    const m = f.match(/^agent-(.+)\.meta\.json$/);
    const agentId = m?.[1];
    if (!agentId || /^a[0-9a-f]{16}$/i.test(agentId)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Record<
        string,
        unknown
      >;
      if (meta.taskKind !== "in_process_teammate") continue;
      if (typeof meta.name !== "string" || typeof meta.teamName !== "string") continue;
      const jsonl = path.join(dir, `agent-${agentId}.jsonl`);
      const lastActiveMs = fs.statSync(fs.existsSync(jsonl) ? jsonl : path.join(dir, f)).mtimeMs;
      out.push({ agentId, name: meta.name, teamName: meta.teamName, lastActiveMs });
    } catch {
      // unreadable meta: skip
    }
  }
  return out;
}
