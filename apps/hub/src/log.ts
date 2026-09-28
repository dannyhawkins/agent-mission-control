import type { Database } from "bun:sqlite";
import type { LogEntry, LogKind, Persona, ServerEvent } from "@amc/shared";

/** Per unengaged session; a session that stays quiet for long just loses the overflow. */
const MAX_HELD = 20;

export class LogStore {
  /** Default agent attribution by session (nested child sessions); set by the hub. */
  tagFor?: (sessionId: string) => { agentId: string; agentRole: string } | undefined;
  /**
   * True while a session is not engaged yet (no prompt, tool, crew or decision):
   * its entries are held here instead of written, then released in order when
   * it engages or discarded if it ends as noise. Set by the hub.
   */
  holdFor?: (sessionId: string) => boolean;
  private held = new Map<string, LogEntry[]>();

  constructor(
    private db: Database,
    private emit: (ev: ServerEvent) => void,
  ) {}

  add(
    persona: Persona,
    kind: LogKind,
    text: string,
    extra: {
      decisionId?: string;
      meta?: Record<string, unknown>;
      agentId?: string;
      agentRole?: string;
    } = {},
  ): LogEntry {
    if (!extra.agentId) {
      const tag = this.tagFor?.(persona.sessionId);
      if (tag) extra = { ...extra, ...tag };
    }
    const entry: LogEntry = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      sessionId: persona.sessionId,
      persona: { name: persona.name, color: persona.color, spriteSeed: persona.spriteSeed },
      kind,
      text,
      ...(extra.decisionId ? { decisionId: extra.decisionId } : {}),
      ...(extra.meta ? { meta: extra.meta } : {}),
      ...(extra.agentId ? { agentId: extra.agentId } : {}),
      ...(extra.agentRole ? { agentRole: extra.agentRole } : {}),
    };
    if (this.holdFor?.(entry.sessionId)) {
      const list = this.held.get(entry.sessionId) ?? [];
      if (list.length < MAX_HELD) list.push(entry);
      this.held.set(entry.sessionId, list);
      return entry;
    }
    this.write(entry);
    return entry;
  }

  /** The session engaged: write and broadcast what it logged so far, in order. */
  release(sessionId: string) {
    const list = this.held.get(sessionId);
    this.held.delete(sessionId);
    for (const e of list ?? []) this.write(e);
  }

  /** The session ended without engaging: it was noise. */
  discard(sessionId: string) {
    this.held.delete(sessionId);
  }

  private write(entry: LogEntry) {
    this.db.run("INSERT INTO log (id, at, session_id, kind, json) VALUES (?, ?, ?, ?, ?)", [
      entry.id,
      entry.at,
      entry.sessionId,
      entry.kind,
      JSON.stringify(entry),
    ]);
    this.emit({ type: "log", entry });
  }

  /** Newest last, as the snapshot contract wants. */
  recent(limit = 200): LogEntry[] {
    const rows = this.db
      .query<{ json: string }, [number]>("SELECT json FROM log ORDER BY at DESC LIMIT ?")
      .all(limit);
    return rows.map((r) => JSON.parse(r.json) as LogEntry).reverse();
  }

  /** Provisional session merge: re-home entries and swap the persona identity. */
  reassign(fromSessionId: string, toSessionId: string, persona: Persona) {
    const held = this.held.get(fromSessionId);
    if (held) {
      this.held.delete(fromSessionId);
      const into = this.held.get(toSessionId) ?? [];
      for (const e of held) {
        e.sessionId = toSessionId;
        e.persona = { name: persona.name, color: persona.color, spriteSeed: persona.spriteSeed };
      }
      this.held.set(toSessionId, [...held, ...into].slice(0, MAX_HELD));
    }
    const rows = this.db
      .query<{ id: string; json: string }, [string]>(
        "SELECT id, json FROM log WHERE session_id = ?",
      )
      .all(fromSessionId);
    const update = this.db.prepare("UPDATE log SET session_id = ?, json = ? WHERE id = ?");
    for (const r of rows) {
      const entry = JSON.parse(r.json) as LogEntry;
      entry.sessionId = toSessionId;
      entry.persona = { name: persona.name, color: persona.color, spriteSeed: persona.spriteSeed };
      update.run(toSessionId, JSON.stringify(entry), r.id);
    }
  }
}
