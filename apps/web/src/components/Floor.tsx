import type { Decision, DecisionAnswerBody, Session } from "@amc/shared";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { ActivityLine } from "../hub/state";
import { Sprite } from "../sprite/Sprite";
import { floorView } from "../util/crew";
import { stationTier, waitingSince } from "../util/escalation";
import { PERSONA_HEX } from "../util/theme";
import { fmtElapsed } from "../util/time";
import { isTyping } from "./DecisionCard";
import { presented, Station } from "./Station";

interface Props {
  sessions: Session[];
  decisions: Decision[];
  activity: Record<string, number>;
  recent: Record<string, ActivityLine[]>;
  hotkeyDecisionId: string | undefined;
  now: number;
  onAnswer: (decision: Decision, body: DecisionAnswerBody) => Promise<void>;
  onDismiss: (decision: Decision) => Promise<void>;
  onTransmitted: () => void;
  onMessage: (sessionId: string, text: string) => Promise<void>;
}

const EMPTY: ActivityLine[] = [];
const EMPTY_DECISIONS: Decision[] = [];
/** Long enough for the TRANSMITTED stamp to land before the floor rearranges. */
const UNFOCUS_AFTER_ANSWER_MS = 2000;

/** Collapsed station in the focus strip: enough to see who needs you and for how long. */
function MiniTile(p: {
  session: Session;
  decisions: Decision[];
  now: number;
  onFocus: () => void;
}) {
  const { s, label } = presented(p.session, p.decisions);
  const tier = stationTier(s, p.decisions, p.now);
  const since = waitingSince(s, p.decisions);
  return (
    <button
      type="button"
      className="mini"
      data-tier={tier}
      data-status={s.status}
      style={{ "--c": PERSONA_HEX[s.persona.color] } as CSSProperties}
      onClick={p.onFocus}
      title={`Focus ${s.persona.name} (${s.project})`}
    >
      <Sprite seed={s.persona.spriteSeed} color={s.persona.color} size={20} animate={false} />
      <span className="mini__name">{s.persona.name}</span>
      <span className="mini__badge" data-status={s.status}>
        {label}
      </span>
      {since !== undefined && (
        <span className="mini__wait" data-tier={tier}>
          {fmtElapsed(p.now - since)}
        </span>
      )}
    </button>
  );
}

/**
 * Only live sessions get a station. Ended sessions collapse into the off-shift
 * strip: background Claude processes (hooks fire for them too) often start and
 * end within a second, and a full dead station per blip would bury the live crew.
 * Nested sessions under a live parent fold into that parent's crew bay (see floorView).
 *
 * Focus mode: one station takes the whole floor, the rest shrink to mini tiles. Unfocused
 * stations stay mounted (hidden) so a half-typed answer is not lost by focusing elsewhere.
 * Deliberately not persisted across reloads.
 */
export function Floor(p: Props) {
  const { stations: live, offShift, decisions } = floorView(p.sessions, p.decisions);
  const [focusId, setFocusId] = useState<string | null>(null);
  const focused = focusId ? live.find((s) => s.id === focusId) : undefined;
  const count = focused ? 1 : Math.min(6, Math.max(1, live.length));

  // While focused, only the focused station's cards may own the number keys.
  const hotkeyDecisionId = focused
    ? decisions[focused.id]?.find((d) => d.source !== "prose")?.id
    : p.hotkeyDecisionId;
  const hotkeyStationId = live.find((s) =>
    decisions[s.id]?.some((d) => d.id === p.hotkeyDecisionId),
  )?.id;

  const toggle = (id: string) => setFocusId((cur) => (cur === id ? null : id));

  // Drop focus if the focused session leaves the floor.
  useEffect(() => {
    if (focusId && !focused) setFocusId(null);
  }, [focusId, focused]);

  // F focuses the station whose card owns the hotkeys; Esc returns to the grid.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === "Escape" && focusId) {
        e.preventDefault();
        setFocusId(null);
      } else if ((e.key === "f" || e.key === "F") && hotkeyStationId && !focusId) {
        e.preventDefault();
        setFocusId(hotkeyStationId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusId, hotkeyStationId]);

  // When the focused station's last card is answered, linger for the stamp, then go back to
  // the grid only if someone else is waiting; otherwise there is nothing better to look at.
  const pendingHere = focused ? (decisions[focused.id]?.length ?? 0) : 0;
  const pendingElsewhere = live.some((s) => s.id !== focusId && (decisions[s.id]?.length ?? 0) > 0);
  const prevPending = useRef(pendingHere);
  const elsewhereRef = useRef(pendingElsewhere);
  elsewhereRef.current = pendingElsewhere;
  useEffect(() => {
    const was = prevPending.current;
    prevPending.current = pendingHere;
    if (!focusId || was === 0 || pendingHere > 0) return;
    const t = setTimeout(() => {
      if (elsewhereRef.current) setFocusId(null);
    }, UNFOCUS_AFTER_ANSWER_MS);
    return () => clearTimeout(t);
  }, [pendingHere, focusId]);

  return (
    <div className="floor-wrap" data-focus={focused ? "" : undefined}>
      {focused && (
        <nav className="focus-strip" aria-label="Other stations">
          <button
            type="button"
            className="mini mini--back"
            onClick={() => setFocusId(null)}
            title="Back to all stations (Esc)"
          >
            ALL
          </button>
          {live
            .filter((s) => s.id !== focused.id)
            .map((s) => (
              <MiniTile
                key={s.id}
                session={s}
                decisions={decisions[s.id] ?? EMPTY_DECISIONS}
                now={p.now}
                onFocus={() => setFocusId(s.id)}
              />
            ))}
        </nav>
      )}
      {live.length === 0 ? (
        <div className="floor-quiet">
          <span className="floor-quiet-label">NO OPERATORS ON SHIFT</span>
          <span>
            Start <code>claude</code> in a wired project and a station opens here.
          </span>
        </div>
      ) : (
        <div className="floor" data-count={count}>
          {live.map((s) => (
            <Station
              key={s.id}
              session={s}
              decisions={decisions[s.id] ?? EMPTY_DECISIONS}
              activityAt={p.activity[s.id]}
              recent={p.recent[s.id] ?? EMPTY}
              hotkeyDecisionId={hotkeyDecisionId}
              now={p.now}
              onAnswer={p.onAnswer}
              onDismiss={p.onDismiss}
              onTransmitted={p.onTransmitted}
              focused={focused?.id === s.id}
              hidden={focused !== undefined && focused.id !== s.id}
              onFocusToggle={() => toggle(s.id)}
              onMessage={p.onMessage}
            />
          ))}
        </div>
      )}
      {offShift.length > 0 && (
        <div className="offshift" aria-label="Ended sessions">
          <span className="offshift-label">OFF SHIFT {offShift.length}</span>
          {offShift.map((s) => (
            <span key={s.id} className="offshift-chip" title={s.cwd}>
              <b style={{ color: `var(--${s.persona.color})` }}>{s.persona.name}</b> {s.project}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
