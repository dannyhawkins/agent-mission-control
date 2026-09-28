import type { LogEntry, LogKind } from "@amc/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { Sprite } from "../sprite/Sprite";
import { crewTint, shortRole } from "../util/crew";
import { PERSONA_HEX } from "../util/theme";
import { fmtElapsed, fmtTime, isToday } from "../util/time";

type Filter = "all" | "decisions" | "alerts";

const DECISION_KINDS = new Set<LogKind>([
  "decision_requested",
  "decision_answered",
  "decision_expired",
]);
const ALERT_KINDS = new Set<LogKind>([
  "permission_prompt",
  "idle",
  "decision_expired",
  "session_end",
]);

function matches(e: LogEntry, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "decisions") return DECISION_KINDS.has(e.kind);
  return ALERT_KINDS.has(e.kind);
}

/** Answer latency: prefer the hub's meta.waitedMs, else pair the request entry by decisionId. */
function responseMs(e: LogEntry, log: LogEntry[]): number | undefined {
  const waited = e.meta?.waitedMs;
  if (typeof waited === "number") return waited;
  if (!e.decisionId) return undefined;
  const req = log.find((x) => x.kind === "decision_requested" && x.decisionId === e.decisionId);
  return req ? Date.parse(e.at) - Date.parse(req.at) : undefined;
}

const ANSWER_MAX = 90;

/** The hub logs the readable summary as `answer`; fall back to flattening `answers` if that is all there is. */
function answerOf(meta: LogEntry["meta"]): string | undefined {
  if (typeof meta?.answer === "string" && meta.answer) return meta.answer;
  const answers = meta?.answers;
  if (!answers || typeof answers !== "object") return undefined;
  const parts = Object.values(answers as Record<string, unknown>).map((v) =>
    Array.isArray(v) ? v.join(", ") : String(v),
  );
  return parts.length ? parts.join(" · ") : undefined;
}

/**
 * Multi-question answers arrive as "Colour: Blue · Toppings: Cheese, Ham" and plan notes can run
 * long, so the log shows a clipped line and keeps the full text in the tooltip.
 */
function AnswerText({ answer, note }: { answer: string; note: unknown }) {
  const full = typeof note === "string" && note ? `${answer} (${note})` : answer;
  const short = full.length > ANSWER_MAX ? `${full.slice(0, ANSWER_MAX - 1)}…` : full;
  return (
    <span className="entry__answer" title={short === full ? undefined : full}>
      {short}
    </span>
  );
}

const CREW_KEY = "amc.log.showCrew";

/** Storage can throw (private mode, blocked site data); the toggle just falls back to on. */
function loadShowCrew(): boolean {
  try {
    return localStorage.getItem(CREW_KEY) !== "0";
  } catch {
    return true;
  }
}

export function MissionLog({ log }: { log: LogEntry[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [showCrew, setShowCrew] = useState(loadShowCrew);
  const listRef = useRef<HTMLOListElement>(null);
  const stickRef = useRef(true);
  const prevHeightRef = useRef(0);

  const visible = useMemo(
    // Newest first: the hub sends the log oldest-first, the rail shows the latest at the top.
    () => log.filter((e) => matches(e, filter) && (showCrew || !e.agentId)).reverse(),
    [log, filter, showCrew],
  );

  const toggleCrew = () => {
    const next = !showCrew;
    setShowCrew(next);
    stickRef.current = true;
    try {
      localStorage.setItem(CREW_KEY, next ? "1" : "0");
    } catch {
      // Not persisted this time; the toggle still works for the session.
    }
  };

  const score = useMemo(() => {
    const answered = log.filter((e) => e.kind === "decision_answered" && isToday(e.at));
    const times = answered
      .map((e) => responseMs(e, log))
      .filter((n): n is number => n !== undefined && n >= 0);
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : undefined;
    return { answered: answered.length, avg };
  }, [log]);

  // Stay pinned to the newest entry at the top. If the operator has scrolled down to
  // read older entries, compensate for rows prepended above so the text under their
  // eyes does not jump.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (stickRef.current) el.scrollTop = 0;
    else el.scrollTop += el.scrollHeight - prevHeightRef.current;
    prevHeightRef.current = el.scrollHeight;
  }, [visible]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = el.scrollTop < 24;
  };

  return (
    <aside className="log" aria-label="Mission log">
      <header className="log__head">
        <span className="log__title">MISSION LOG</span>
        <div className="chips" role="tablist" aria-label="Filter log">
          {(["all", "decisions", "alerts"] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className="chip"
              data-active={filter === f ? "" : undefined}
              onClick={() => {
                setFilter(f);
                stickRef.current = true;
              }}
            >
              {f === "all" ? "ALL" : f === "decisions" ? "DECISIONS" : "ALERTS"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="chip chip--toggle"
          aria-pressed={showCrew}
          title={showCrew ? "Hide subagent and crew entries" : "Show subagent and crew entries"}
          onClick={toggleCrew}
        >
          CREW
        </button>
      </header>

      <ol className="log__list" ref={listRef} onScroll={onScroll}>
        {visible.length === 0 && <li className="log__empty">Nothing logged yet.</li>}
        {visible.map((e) => (
          <li
            key={e.id}
            className="entry"
            data-kind={e.kind}
            data-crew={e.agentId ? "" : undefined}
          >
            <time className="entry__time" dateTime={e.at}>
              {fmtTime(e.at)}
            </time>
            {e.agentId ? (
              <>
                <span className="entry__glyph" aria-hidden="true">
                  └
                </span>
                <span
                  className="entry__who"
                  style={{ color: crewTint(e.persona.color) }}
                  title={`${e.persona.name} / ${e.agentRole ?? e.agentId}`}
                >
                  {shortRole(e.agentRole ?? "agent")}
                </span>
              </>
            ) : (
              <>
                <Sprite
                  seed={e.persona.spriteSeed}
                  color={e.persona.color}
                  size={18}
                  animate={false}
                />
                <span className="entry__who" style={{ color: PERSONA_HEX[e.persona.color] }}>
                  {e.persona.name}
                </span>
              </>
            )}
            <span className="entry__text">
              {ALERT_KINDS.has(e.kind) && (
                <span className="entry__alert" role="img" aria-label="alert">
                  !
                </span>
              )}
              {e.text}
              {e.kind === "decision_answered" && answerOf(e.meta) && (
                <AnswerText answer={answerOf(e.meta) ?? ""} note={e.meta?.note} />
              )}
            </span>
          </li>
        ))}
      </ol>

      <footer className="score">
        <span className="score__item">
          <span className="score__label">ANSWERED TODAY</span>
          <span className="score__value">{score.answered}</span>
        </span>
        <span className="score__item">
          <span className="score__label">AVG RESPONSE</span>
          <span className="score__value">
            {score.avg === undefined ? "--:--" : fmtElapsed(score.avg)}
          </span>
        </span>
      </footer>
    </aside>
  );
}
