import type { Database } from "bun:sqlite";
import { type HubLogger, shortPath } from "./hublog";

/**
 * Sessions the operator never wants to see (config.ignoreCwd). Global wiring
 * reaches every `claude` on the machine, including tools' own background
 * sessions such as claude-mem's observers, which would clutter the floor and,
 * worse, have their permission prompts held by the gate.
 *
 * Matching is by cwd prefix; once a session id is known to be ignored it is
 * remembered, so later hooks, OTLP or MCP calls that carry only the id are
 * dropped too.
 */
export class IgnoreList {
  private ids = new Set<string>();
  private logged = new Set<string>();

  constructor(
    private prefixes: string[],
    private logger?: HubLogger,
  ) {}

  matchesCwd(cwd: string | undefined): boolean {
    if (!cwd) return false;
    return this.prefixes.some((p) => cwd === p || cwd.startsWith(p.endsWith("/") ? p : `${p}/`));
  }

  /** True when the session should be dropped. Learns the id on a cwd match. */
  check(sessionId: string | undefined, cwd: string | undefined): boolean {
    if (sessionId && this.ids.has(sessionId)) return true;
    if (!this.matchesCwd(cwd)) return false;
    if (sessionId) this.ids.add(sessionId);
    const key = sessionId ?? cwd ?? "";
    if (!this.logged.has(key)) {
      this.logged.add(key);
      this.logger?.info("ignored ", shortPath(cwd), sessionId);
    }
    return true;
  }

  has(sessionId: string | undefined): boolean {
    return !!sessionId && this.ids.has(sessionId);
  }

  /**
   * Startup cleanup: rows written before the prefix was ignored (or before this
   * feature existed). Runs before the stores load, so nothing reaches the UI.
   */
  purge(db: Database): { sessions: number; log: number; decisions: number } {
    const rows = db.query<{ id: string; json: string }, []>("SELECT id, json FROM sessions").all();
    const ids: string[] = [];
    for (const r of rows) {
      try {
        const cwd = (JSON.parse(r.json) as { session?: { cwd?: string } }).session?.cwd;
        if (this.matchesCwd(cwd)) ids.push(r.id);
      } catch {
        // unreadable row: leave it for the session store to skip
      }
    }
    const counts = { sessions: ids.length, log: 0, decisions: 0 };
    for (const id of ids) {
      this.ids.add(id);
      counts.log += db.run("DELETE FROM log WHERE session_id = ?", [id]).changes;
      counts.decisions += db.run("DELETE FROM decisions WHERE session_id = ?", [id]).changes;
      db.run("DELETE FROM personas WHERE session_id = ?", [id]);
      db.run("DELETE FROM sessions WHERE id = ?", [id]);
    }
    return counts;
  }
}
