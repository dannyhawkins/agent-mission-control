import type { ServerEvent, StateSnapshot } from "@amc/shared";
import type { ServerWebSocket } from "bun";

export type WsData = { id: string };

/**
 * Fan-out of ServerEvents to every connected UI. Bun's pub/sub would also
 * work, but a plain Set keeps the snapshot-on-connect path obvious.
 */
export class Broadcaster {
  private clients = new Set<ServerWebSocket<WsData>>();
  private listeners = new Set<(ev: ServerEvent) => void>();

  add(ws: ServerWebSocket<WsData>, snapshot: () => StateSnapshot) {
    this.clients.add(ws);
    ws.send(JSON.stringify({ type: "snapshot", state: snapshot() } satisfies ServerEvent));
  }

  remove(ws: ServerWebSocket<WsData>) {
    this.clients.delete(ws);
  }

  /** In-process subscribers (tests, gate waits). */
  subscribe(fn: (ev: ServerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  broadcast(ev: ServerEvent) {
    const payload = JSON.stringify(ev);
    for (const ws of this.clients) {
      try {
        ws.send(payload);
      } catch {
        this.clients.delete(ws);
      }
    }
    for (const fn of this.listeners) fn(ev);
  }

  get size() {
    return this.clients.size;
  }
}
