import type {
  CrewMember,
  Decision,
  DecisionAnswerBody,
  EscalationTier,
  Session,
} from "@amc/shared";
import { type CSSProperties, useEffect, useState } from "react";
import { AnswerError } from "../hub/errors";
import type { ActivityLine } from "../hub/state";
import { Sprite, type SpriteState } from "../sprite/Sprite";
import { crewBusy, crewOf, crewTint, seedFrom, splitRolePrefix } from "../util/crew";
import { stationTier, waitingSince } from "../util/escalation";
import { PERSONA_HEX, STATUS_LABEL } from "../util/theme";
import { fmtCost, fmtElapsed, fmtTime, fmtTokens, shortPath } from "../util/time";
import { CrewBay } from "./CrewBay";
import { DecisionCard, type Via } from "./DecisionCard";
import { MessageBox } from "./MessageBox";

interface Props {
  session: Session;
  decisions: Decision[];
  activityAt: number | undefined;
  recent: ActivityLine[];
  hotkeyDecisionId: string | undefined;
  now: number;
  onAnswer: (decision: Decision, body: DecisionAnswerBody) => Promise<void>;
  onDismiss: (decision: Decision) => Promise<void>;
  onTransmitted: () => void;
  /** Focus mode: this station fills the floor and its cards get the room. */
  focused: boolean;
  /** Hidden while another station is focused; kept mounted so half-typed answers survive. */
  hidden: boolean;
  onFocusToggle: () => void;
  onMessage: (sessionId: string, text: string) => Promise<void>;
}

/** Absent on older hubs: no message route, no box. */
function canMessage(s: Session): boolean {
  return s.canMessage === true;
}

function spriteState(status: Session["status"], tier: EscalationTier): SpriteState {
  if (status === "offline") return "offline";
  if (tier === "red" || tier === "alarm") return "alarm";
  if (status === "waiting_decision" || status === "waiting_permission") return "waiting";
  if (status === "working") return "working";
  return "idle";
}

/** Tints a leading "Role: " when it names a crew member; anything else renders untouched. */
function CrewLine({ line, crew }: { line: string; crew: CrewMember[] }) {
  const split = splitRolePrefix(line, crew);
  if (!split) return <ActivityText line={line} />;
  return (
    <>
      <span className="ticker__role">{split.prefix}</span>
      <ActivityText line={split.rest} />
    </>
  );
}

/**
 * Hub activity lines are "voice phrase · target" (one per tool call) or "✗ Tool failed · target".
 * The target is the fact you scan for, so it gets full ink; the persona voice stays quiet.
 */
function ActivityText({ line }: { line: string }) {
  const failed = line.startsWith("✗");
  const body = failed ? line.slice(1).trimStart() : line;
  const cut = body.indexOf(" · ");
  return (
    <>
      {failed && <span className="act__fail">✗ </span>}
      {cut < 0 ? (
        body
      ) : (
        <>
          <span className="act__voice">{body.slice(0, cut)}</span>
          <span className="act__sep"> · </span>
          <span className="act__target">{body.slice(cut + 3)}</span>
        </>
      )}
    </>
  );
}

function viaFor(d: Decision, crew: CrewMember[], tint: string): Via | undefined {
  if (!d.agentId) return undefined;
  const m = crew.find((c) => c.id === d.agentId);
  const role = m?.kind === "child_session" ? "child_session" : (m?.role ?? d.agentRole ?? "agent");
  return { role, seed: m?.spriteSeed ?? seedFrom(d.agentId), tint };
}

/**
 * A pending decision means the station is waiting on you, whatever the hub's session status says:
 * prose cards arrive on a session that has gone "idle", crew decisions on one that is "working".
 */
export function effectiveStatus(
  status: Session["status"],
  decisions: Decision[],
): Session["status"] {
  if (decisions.length === 0 || status === "offline") return status;
  if (status === "waiting_decision" || status === "waiting_permission") return status;
  return decisions.every((d) => d.source === "permission")
    ? "waiting_permission"
    : "waiting_decision";
}

/** The session as the floor should present it, given its pending cards. */
export function presented(session: Session, decisions: Decision[]) {
  // Main thread idle but crew still out: the station is working, not READY.
  const base = session.status === "idle" && crewBusy(session) ? "working" : session.status;
  const status = effectiveStatus(base, decisions);
  const s = status === session.status ? session : { ...session, status };
  const onlyProse = decisions.length > 0 && decisions.every((d) => d.source === "prose");
  return { s, label: onlyProse ? "WAITING: YOU" : STATUS_LABEL[s.status] };
}

export function Station(p: Props) {
  const { s, label } = presented(p.session, p.decisions);
  const tier = stationTier(s, p.decisions, p.now);
  const since = waitingSince(s, p.decisions);
  const [flash, setFlash] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(t);
  }, [flash]);

  const crew = crewOf(s);
  const tint = crewTint(s.persona.color);
  const style = { "--c": PERSONA_HEX[s.persona.color], "--ct": tint } as CSSProperties;
  const pulseKey = p.activityAt ?? 0;
  const loud = tier === "red" || tier === "alarm";
  // Ready for the next prompt: calm blue, never part of the escalation ladder.
  const ready = s.status === "idle" && p.decisions.length === 0;
  const idleSince = ready ? Date.parse(s.blockedSince ?? s.lastSeenAt) : Number.NaN;

  return (
    <article
      className="station"
      hidden={p.hidden}
      tabIndex={0}
      data-focused={p.focused ? "" : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) {
          // Stop here so the owning card's window-level Enter-to-send does not also fire.
          e.preventDefault();
          e.stopPropagation();
          p.onFocusToggle();
        }
      }}
      data-status={s.status}
      data-tier={tier}
      data-crew={crew.length > 0 ? "" : undefined}
      data-ready={ready ? "" : undefined}
      style={style}
      aria-label={`${s.persona.name} on ${s.project}, ${label.toLowerCase()}`}
    >
      <span className="lamp px" data-tier={tier} aria-hidden="true" />

      <header
        className="head"
        onClick={p.onFocusToggle}
        title={p.focused ? "Back to all stations (Esc)" : "Focus this station (F)"}
      >
        <Sprite
          seed={s.persona.spriteSeed}
          color={s.persona.color}
          size={48}
          state={spriteState(s.status, tier)}
          title={s.persona.tagline}
        />
        <div className="head__id">
          <div className="name" title={s.persona.tagline}>
            {s.persona.name}
          </div>
          <div className="proj" title={s.cwd}>
            <b>{s.project}</b>
            <span className="proj__path">{shortPath(s.cwd)}</span>
          </div>
        </div>
        <span className="badge" data-status={s.status}>
          <i className="glyph px" data-status={s.status} aria-hidden="true" />
          {label}
        </span>
      </header>

      <div className="screen">
        <div className="ticker" key={s.statusLine} title={s.statusLine}>
          {s.statusLine ? <CrewLine line={s.statusLine} crew={crew} /> : "..."}
        </div>
        <div className="signal" aria-hidden="true">
          <i key={pulseKey} data-live={pulseKey ? "" : undefined} />
        </div>
      </div>

      <CrewBay crew={crew} tint={tint} />

      <div className="body">
        {notice && (
          <p className="station__notice" role="status">
            {notice}
          </p>
        )}
        {flash && (
          <div className="stamp" role="status">
            <span className="stamp__art px" aria-hidden="true" />
            <span className="stamp__text">TRANSMITTED</span>
          </div>
        )}
        {p.decisions.map((d) => (
          <DecisionCard
            key={d.id}
            decision={d}
            hotkeys={d.id === p.hotkeyDecisionId}
            via={viaFor(d, crew, tint)}
            roomy={p.focused}
            onAnswer={async (body) => {
              try {
                await p.onAnswer(d, body);
              } catch (e) {
                // The card is already gone; say why on the station instead of failing silently.
                if (e instanceof AnswerError && e.kind === "not_waiting") {
                  setNotice(e.message);
                  return;
                }
                throw e;
              }
              setFlash(d.id);
              p.onTransmitted();
            }}
            onDismiss={() => p.onDismiss(d)}
          />
        ))}
        {p.decisions.length === 0 && !flash && p.recent.length > 0 && (
          <ol className="scrollback" aria-label="Recent activity">
            {p.recent.map((a) => (
              <li key={`${a.at}${a.line}`}>
                <span className="scrollback__time">{fmtTime(a.at)}</span>
                <span>
                  <CrewLine line={a.line} crew={crew} />
                </span>
              </li>
            ))}
          </ol>
        )}
        {p.decisions.length === 0 && !flash && p.recent.length === 0 && (
          <div className="standby">
            {s.status === "working" && <span>Working. Nothing needs you here.</span>}
            {s.status === "idle" && (
              <span>
                {canMessage(s)
                  ? "Ready for the next prompt. Message it below or in the terminal."
                  : "Ready for the next prompt in the terminal."}
              </span>
            )}
            {s.status === "offline" && <span>Signal lost.</span>}
            {s.status === "waiting_permission" && (
              <span>Permission prompt open in the terminal. Answer it there.</span>
            )}
            {s.status === "waiting_decision" && (
              <span>Awaiting a decision (not received yet).</span>
            )}
          </div>
        )}
      </div>

      <div className="foot">
        {canMessage(s) && (
          <MessageBox sessionName={s.persona.name} onSend={(text) => p.onMessage(s.id, text)} />
        )}
        <footer className="stats">
          <span>
            TOOLS <b>{s.stats.toolCalls}</b>
          </span>
          <span
            title={`${fmtTokens(s.stats.inputTokens)} in / ${fmtTokens(s.stats.outputTokens)} out`}
          >
            TOKENS <b>{fmtTokens(s.stats.inputTokens + s.stats.outputTokens)}</b>
          </span>
          <span>
            COST <b>{fmtCost(s.stats.costUsd)}</b>
          </span>
          <span>
            DECISIONS <b>{s.stats.decisionsAnswered}</b>
          </span>
          {s.model && <span className="stats__model">{s.model.replace(/^claude-/, "")}</span>}
          {since !== undefined && (
            <span className="wait" data-tier={tier}>
              {loud && <i className="klaxon px" aria-hidden="true" />}
              WAITING {fmtElapsed(p.now - since)}
            </span>
          )}
          {ready && !Number.isNaN(idleSince) && (
            <span className="idle-for">IDLE {fmtElapsed(Math.max(0, p.now - idleSince))}</span>
          )}
        </footer>
      </div>
    </article>
  );
}
