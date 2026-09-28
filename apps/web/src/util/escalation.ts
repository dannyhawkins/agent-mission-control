import { type Decision, type EscalationTier, escalationTier, type Session } from "@amc/shared";

const RANK: Record<EscalationTier, number> = { calm: 0, amber: 1, red: 2, alarm: 3 };

export function tierRank(t: EscalationTier): number {
  return RANK[t];
}

/**
 * A station escalates on whichever is older: the session's own blocked timestamp or its
 * oldest pending decision. Only a permission prompt counts as "blocked": an idle session has
 * simply finished its turn and is waiting for the next prompt, which is not something to
 * strobe about (it used to go red after 5 minutes of ordinary idleness). Working sessions ignore a stale
 * blockedSince, but a crew member's decision still escalates: the parent reads as "working"
 * while it sits in the Task tool waiting on a subagent that is itself waiting on you.
 */
export function stationTier(session: Session, decisions: Decision[], now: number): EscalationTier {
  if (session.status === "offline") return "calm";
  const busy = session.status === "working";
  let tier: EscalationTier = escalationTier(blockedSince(session), now);
  for (const d of busy ? decisions.filter((x) => x.agentId) : decisions) {
    const t = escalationTier(d.createdAt, now);
    if (RANK[t] > RANK[tier]) tier = t;
  }
  return tier;
}

/** Earliest timestamp the station has been waiting on, for the WAITING mm:ss readout. */
export function waitingSince(session: Session, decisions: Decision[]): number | undefined {
  if (session.status === "offline") return undefined;
  const busy = session.status === "working";
  const counted = busy ? decisions.filter((d) => d.agentId) : decisions;
  const candidates = [blockedSince(session), ...counted.map((d) => d.createdAt)]
    .filter((x): x is string => Boolean(x))
    .map((x) => Date.parse(x))
    .filter((n) => !Number.isNaN(n));
  return candidates.length ? Math.min(...candidates) : undefined;
}

function blockedSince(session: Session): string | undefined {
  return session.status === "waiting_permission" ? session.blockedSince : undefined;
}
