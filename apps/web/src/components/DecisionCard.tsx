import type { Decision, DecisionAnswerBody, DecisionOption } from "@amc/shared";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Sprite } from "../sprite/Sprite";
import { shortRole } from "../util/crew";
import { AskCard } from "./AskCard";
import { ContextBlock, commandOf, DiffPreview } from "./ContextBlock";
import { ProseCard } from "./ProseCard";

/** The crew member who actually asked, when it was not the station's own operator. */
export interface Via {
  role: string;
  seed: number;
  tint: string;
}

export interface CardProps {
  decision: Decision;
  /** Only one card on the floor owns the number keys at a time. */
  hotkeys: boolean;
  onAnswer: (body: DecisionAnswerBody) => Promise<void>;
  /** Retire the card without answering (prose cards nobody can answer from here). */
  onDismiss: () => Promise<void>;
  via?: Via;
  /** The station is focused: open context by default, let blocks grow. */
  roomy?: boolean;
}

export const TITLE: Record<Decision["source"], string> = {
  mcp: "INCOMING TRANSMISSION",
  permission: "PERMISSION REQUEST",
  hook: "NOTICE",
  ask: "QUESTIONS",
  plan: "PLAN APPROVAL",
  prose: "WAITING ON YOU",
};

/**
 * Fallback when a plan decision arrives without options. The labels are the contract with the
 * hub's gate (it maps them to ExitPlanMode outcomes), so they must match it exactly.
 */
const PLAN_OPTIONS: DecisionOption[] = [
  { label: "Approve", recommended: true },
  { label: "Approve + auto-accept edits" },
  { label: "Keep planning" },
];

export function isTyping(el: EventTarget | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/**
 * Agents write `code` in questions. Backtick spans become styled chips; everything stays text,
 * never markup. An unmatched backtick is left as typed.
 */
export function CodeText({ text }: { text: string }) {
  const parts = text.split(/`([^`\n]+)`/);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="icode">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** Shared title row: label, who asked (crew), urgency and hotkey tags. */
export function CardHead({
  title,
  decision,
  via,
  keysTag,
}: {
  title: string;
  decision: Decision;
  via?: Via;
  keysTag?: ReactNode;
}) {
  return (
    <div className="card__head">
      <span className="lbl">
        <i className="envelope px" aria-hidden="true" />
        {title}
      </span>
      {via && (
        <span className="via" title={`Raised by ${via.role}`}>
          <Sprite seed={via.seed} color="amber" hex={via.tint} size={12} animate={false} />
          VIA {shortRole(via.role)}
        </span>
      )}
      <span className="card__meta">
        {decision.urgency !== "normal" && (
          <span className="tag" data-urgency={decision.urgency}>
            {decision.urgency.toUpperCase()}
          </span>
        )}
        {keysTag}
      </span>
    </div>
  );
}

/**
 * Plans arrive as markdown. Rendering it as HTML is off the table (it is agent-supplied text),
 * so headings lose their hashes and get emphasis, bullets become dots, and the rest stays verbatim.
 */
function PlanText({ plan }: { plan: string }) {
  return (
    <pre className="card__plan">
      {plan.split("\n").map((line, i) => {
        const h = /^#{1,6}\s+(.*)$/.exec(line);
        const key = `${i}`;
        if (h) {
          return (
            <span key={key} className="card__plan-h">
              {h[1]}
              {"\n"}
            </span>
          );
        }
        return `${line.replace(/^(\s*)[-*+]\s+/, "$1• ").replace(/\*\*(.+?)\*\*/g, "$1")}\n`;
      })}
    </pre>
  );
}

export function DecisionCard(p: CardProps) {
  if (p.decision.source === "ask" && p.decision.questions?.length) return <AskCard {...p} />;
  if (p.decision.source === "prose") return <ProseCard {...p} />;
  return <ChoiceCard {...p} />;
}

function ChoiceCard({ decision: raw, hotkeys, onAnswer, via, roomy }: CardProps) {
  const isPlan = raw.source === "plan";
  const decision = isPlan && raw.options.length === 0 ? { ...raw, options: PLAN_OPTIONS } : raw;
  const [selected, setSelected] = useState<number | null>(null);
  const [free, setFree] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keyCount = Math.min(6, decision.options.length);
  // request_decision replies can always be free text (the hub accepts it whatever the agent set).
  const freeText = decision.allowFreeText || decision.source === "mcp";
  const answerable = decision.options.length > 0 || freeText;
  const answerText = selected !== null ? (decision.options[selected]?.label ?? "") : free.trim();
  const canSend = answerable && !sending && answerText.length > 0;

  const send = useCallback(async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await onAnswer({ answer: answerText, note: note.trim() || undefined });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transmit failed");
      setSending(false);
    }
  }, [canSend, answerText, note, onAnswer]);

  // Number keys pick an option, Enter sends. Typing in another card's input is left alone.
  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter" && !e.shiftKey) {
        const ownInput =
          isTyping(e.target) &&
          (e.target as HTMLElement).closest(`[data-decision="${decision.id}"]`) !== null;
        if (isTyping(e.target) && !ownInput) return;
        e.preventDefault();
        void send();
        return;
      }
      if (isTyping(e.target)) return;
      const n = Number.parseInt(e.key, 10);
      if (n >= 1 && n <= keyCount) {
        e.preventDefault();
        setSelected(n - 1);
        setFree("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkeys, send, keyCount, decision.id]);

  // Permission prompts carry the tool input instead of prose; show it as the details block unless
  // it is already on the card (a plan, a diff preview, or the Bash command in full).
  const command = commandOf(decision);
  const shownInline = isPlan || decision.changePreview !== undefined || command !== undefined;
  const context =
    decision.context ??
    (decision.toolInput !== undefined && !shownInline
      ? JSON.stringify(decision.toolInput, null, 2)
      : undefined);

  return (
    <section
      className="card"
      data-source={decision.source}
      data-urgency={decision.urgency}
      data-hotkeys={hotkeys}
      data-decision={decision.id}
      aria-label={TITLE[decision.source]}
    >
      <CardHead
        title={TITLE[decision.source]}
        decision={decision}
        via={via}
        keysTag={hotkeys && keyCount > 0 && <span className="tag">KEYS 1-{keyCount}</span>}
      />

      <p className="card__q">
        <CodeText text={decision.question} />
      </p>

      {isPlan && decision.plan && <PlanText plan={decision.plan} />}
      {command !== undefined && <pre className="card__cmd">{command}</pre>}
      {decision.changePreview && <DiffPreview preview={decision.changePreview} />}

      <ContextBlock decision={decision} open={roomy || undefined} />

      {context && (
        <details className="card__ctx">
          <summary>{decision.toolName ? `Details (${decision.toolName})` : "Details"}</summary>
          <pre>{context}</pre>
        </details>
      )}

      {answerable ? (
        <>
          {decision.options.length > 0 && (
            <fieldset className="opts">
              <legend className="sr-only">Options</legend>
              {decision.options.map((o, i) => (
                <button
                  key={o.label}
                  type="button"
                  aria-pressed={selected === i}
                  className="opt"
                  data-recommended={o.recommended ? "" : undefined}
                  data-selected={selected === i ? "" : undefined}
                  disabled={sending}
                  onClick={() => {
                    setSelected(i);
                    setFree("");
                  }}
                >
                  <span className="opt__k">{i + 1}</span>
                  <span className="opt__label">{o.label}</span>
                  {o.description && (
                    <span className="opt__desc" title={o.description}>
                      {o.description}
                    </span>
                  )}
                  {o.recommended && <span className="opt__rec">REC</span>}
                </button>
              ))}
            </fieldset>
          )}

          <div className="card__actions">
            {freeText && (
              <label className="field">
                <span className="sr-only">Or type an answer</span>
                <input
                  type="text"
                  value={free}
                  disabled={sending}
                  placeholder="or type a different answer"
                  onChange={(e) => {
                    setFree(e.target.value);
                    if (e.target.value) setSelected(null);
                  }}
                />
              </label>
            )}
            <label className="field">
              <span className="sr-only">Note to agent</span>
              <input
                type="text"
                value={note}
                disabled={sending}
                placeholder={
                  isPlan ? "what to change (sent to Claude)" : "note to agent (optional)"
                }
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn btn--send"
              disabled={!canSend}
              onClick={() => void send()}
            >
              {sending ? "Sending" : "Send"}
            </button>
          </div>
          {error && (
            <p className="card__error" role="alert">
              {error}
            </p>
          )}
        </>
      ) : (
        <p className="card__info">Informational. No answer expected.</p>
      )}
    </section>
  );
}
