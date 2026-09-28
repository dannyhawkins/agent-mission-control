import type { Database } from "bun:sqlite";

/** Matches the UI's per-station history length. */
export const ACTIVITY_CAP = 80;

export interface ActivityLine {
  at: string;
  line: string;
}

/**
 * The last ACTIVITY_CAP activity lines per session, so a page reload or hub
 * restart still shows each station's recent history (StateSnapshot.recentActivity).
 * In memory, written through to SQLite; pruned per session as it grows.
 */
export class ActivityStore {
  private bySession = new Map<string, ActivityLine[]>();
  private sincePrune = new Map<string, number>();

  constructor(private db: Database) {
    const rows = db
      .query<{ session_id: string; at: string; line: string }, []>(
        "SELECT session_id, at, line FROM activity ORDER BY at, rowid",
      )
      .all();
    for (const r of rows) this.push(r.session_id, { at: r.at, line: r.line });
  }

  add(sessionId: string, entry: ActivityLine) {
    this.push(sessionId, entry);
    this.db.run("INSERT INTO activity (session_id, at, line) VALUES (?, ?, ?)", [
      sessionId,
      entry.at,
      entry.line,
    ]);
    // Trim the table in batches rather than on every insert.
    const n = (this.sincePrune.get(sessionId) ?? 0) + 1;
    if (n >= 20) {
      this.db.run(
        `DELETE FROM activity WHERE session_id = ? AND rowid NOT IN
           (SELECT rowid FROM activity WHERE session_id = ? ORDER BY at DESC, rowid DESC LIMIT ?)`,
        [sessionId, sessionId, ACTIVITY_CAP],
      );
      this.sincePrune.set(sessionId, 0);
    } else {
      this.sincePrune.set(sessionId, n);
    }
  }

  drop(sessionId: string) {
    this.bySession.delete(sessionId);
    this.sincePrune.delete(sessionId);
    this.db.run("DELETE FROM activity WHERE session_id = ?", [sessionId]);
  }

  /** Oldest first, for the sessions given (the ones still on the floor). */
  recent(sessionIds: string[]): Record<string, ActivityLine[]> {
    const out: Record<string, ActivityLine[]> = {};
    for (const id of sessionIds) {
      const list = this.bySession.get(id);
      if (list?.length) out[id] = [...list];
    }
    return out;
  }

  private push(sessionId: string, entry: ActivityLine) {
    const list = this.bySession.get(sessionId) ?? [];
    list.push(entry);
    if (list.length > ACTIVITY_CAP) list.splice(0, list.length - ACTIVITY_CAP);
    this.bySession.set(sessionId, list);
  }
}
