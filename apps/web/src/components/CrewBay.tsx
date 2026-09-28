import type { CrewMember } from "@amc/shared";
import type { CSSProperties } from "react";
import { Sprite, type SpriteState } from "../sprite/Sprite";
import { shortRole } from "../util/crew";

const MAX_VISIBLE = 6;
const ORDER: Record<CrewMember["status"], number> = {
  waiting_decision: 0,
  working: 1,
  standby: 2,
  done: 3,
};

const SPRITE_STATE: Record<CrewMember["status"], SpriteState> = {
  working: "working",
  waiting_decision: "alarm",
  standby: "idle",
  done: "idle",
};

const KIND_LABEL: Record<CrewMember["kind"], string> = {
  subagent: "subagent",
  teammate: "teammate",
  child_session: "nested session",
};

/** Start the done fade where it would be had we been watching since endedAt. */
function fadeFrom(m: CrewMember): CSSProperties | undefined {
  if (m.status !== "done" || !m.endedAt) return undefined;
  const elapsed = Date.now() - Date.parse(m.endedAt);
  return Number.isNaN(elapsed) ? undefined : { animationDelay: `${-Math.max(0, elapsed)}ms` };
}

function tooltip(m: CrewMember): string {
  const bits = [`${m.role} (${KIND_LABEL[m.kind]})`, m.id, `${m.toolCalls} tool calls`];
  if (m.label) bits.unshift(m.label);
  if (m.team) bits.push(`team ${m.team}`);
  if (m.lastTool) bits.push(`last tool ${m.lastTool}`);
  if (m.status === "waiting_decision") bits.push("waiting on you");
  if (m.status === "standby") bits.push("standby (between tasks)");
  if (m.status === "done") bits.push("finished");
  return bits.join("\n");
}

/** Bay label: a subagent's spawn label when the hub has one, else a short role. */
export function crewLabel(m: CrewMember): string {
  if (m.kind === "child_session") return shortRole("child_session");
  return m.label ? m.label.toUpperCase() : shortRole(m.role);
}

/** Waiting, then working, then standby, then done; spawn order within each group. */
export function sortCrew(crew: CrewMember[]): CrewMember[] {
  return crew
    .map((m, i) => ({ m, i }))
    .sort((a, b) => ORDER[a.m.status] - ORDER[b.m.status] || a.i - b.i)
    .map((x) => x.m);
}

/**
 * Junior crew under the parent's screen. Waiting members sort first so they are never hidden
 * behind "+N", standby teammates (between tasks, drawn dim) after everyone on shift; otherwise
 * the hub's order (spawn order) is kept so sprites do not shuffle.
 * Renders nothing for an empty crew so crewless stations look exactly as before.
 */
export function CrewBay({ crew, tint }: { crew: CrewMember[]; tint: string }) {
  if (crew.length === 0) return null;
  const sorted = sortCrew(crew);
  const shown = sorted.slice(0, MAX_VISIBLE);
  const hidden = sorted.length - shown.length;

  return (
    <ul className="crew" aria-label="Crew" style={{ "--ct": tint } as CSSProperties}>
      {shown.map((m) => (
        <li
          key={m.id}
          className="crew__m"
          data-status={m.status}
          data-labelled={m.label ? "" : undefined}
          title={tooltip(m)}
          style={fadeFrom(m)}
        >
          <span className="crew__sprite">
            <Sprite
              seed={m.spriteSeed}
              color="amber"
              hex={tint}
              size={16}
              animate={false}
              state={SPRITE_STATE[m.status]}
            />
            <i className="crew__dot" aria-hidden="true" />
          </span>
          <span className="crew__role">{crewLabel(m)}</span>
        </li>
      ))}
      {hidden > 0 && (
        <li
          className="crew__more"
          title={sorted
            .slice(MAX_VISIBLE)
            .map((m) => m.label ?? m.role)
            .join(", ")}
        >
          +{hidden}
        </li>
      )}
    </ul>
  );
}
