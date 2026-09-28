// Builders for the wire types, shared by the web hub/app tests.
import type { Decision, LogEntry, Session } from "@amc/shared";

export const T0 = "2026-09-25T10:00:00.000Z";

export function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    persona: {
      sessionId: id,
      name: id.toUpperCase(),
      color: "green",
      voice: "deadpan",
      spriteSeed: 7,
      tagline: "tag",
    },
    status: "working",
    cwd: `/Users/x/code/${id}`,
    project: id,
    startedAt: T0,
    lastSeenAt: T0,
    statusLine: "",
    stats: { toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, decisionsAnswered: 0 },
    engaged: true,
    crew: [],
    ...extra,
  };
}

export function decision(id: string, sessionId: string, extra: Partial<Decision> = {}): Decision {
  return {
    id,
    sessionId,
    source: "mcp",
    question: `Question ${id}?`,
    options: [{ label: "Yes" }, { label: "No" }],
    urgency: "normal",
    status: "pending",
    createdAt: T0,
    allowFreeText: true,
    ...extra,
  };
}

export function logEntry(id: string, extra: Partial<LogEntry> = {}): LogEntry {
  return {
    id,
    at: T0,
    sessionId: "s1",
    persona: { name: "NOVA", color: "green", spriteSeed: 7 },
    kind: "note",
    text: `entry ${id}`,
    ...extra,
  };
}
