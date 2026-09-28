import type { AskQuestion } from "@amc/shared";
import { useCallback, useEffect, useState } from "react";
import { ContextBlock } from "./ContextBlock";
import { CardHead, type CardProps, CodeText, isTyping, TITLE } from "./DecisionCard";

type Answer = string | string[];

/** Single-select: custom text wins over a pick. Multi-select: picks plus the custom text, if any. */
function answerFor(q: AskQuestion, picks: number[], other: string): Answer | undefined {
  const custom = other.trim();
  const labels = picks.map((i) => q.options[i]?.label).filter((l): l is string => Boolean(l));
  if (q.multiSelect) {
    const all = custom ? [...labels, custom] : labels;
    return all.length ? all : undefined;
  }
  return custom || labels[0];
}

/**
 * Claude Code's AskUserQuestion: 1 to 4 questions in one card, answered together. The number
 * keys drive the active question, which follows the first unanswered one unless Tab moves it.
 */
export function AskCard({ decision, hotkeys, onAnswer, via, roomy }: CardProps) {
  const questions = decision.questions ?? [];
  const [picks, setPicks] = useState<number[][]>(() => questions.map(() => []));
  const [other, setOther] = useState<string[]>(() => questions.map(() => ""));
  const [active, setActive] = useState(0);
  const [preview, setPreview] = useState<{ q: number; i: number } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answers = questions.map((q, i) => answerFor(q, picks[i] ?? [], other[i] ?? ""));
  const complete = answers.every((a) => a !== undefined);
  const canSend = complete && !sending;
  const title = questions.length === 1 ? "QUESTION" : TITLE.ask;

  const nextUnanswered = useCallback(
    (from: number, done: (Answer | undefined)[]) => {
      for (let k = 1; k <= questions.length; k++) {
        const j = (from + k) % questions.length;
        if (done[j] === undefined) return j;
      }
      return from;
    },
    [questions.length],
  );

  const pick = useCallback(
    (qi: number, oi: number) => {
      const q = questions[qi];
      if (!q) return;
      const cur = picks[qi] ?? [];
      const nextPicks = q.multiSelect
        ? cur.includes(oi)
          ? cur.filter((x) => x !== oi)
          : [...cur, oi]
        : [oi];
      const all = picks.map((p, i) => (i === qi ? nextPicks : p));
      setPicks(all);
      if (!q.multiSelect) {
        const nextOther = other.map((o, i) => (i === qi ? "" : o));
        setOther(nextOther);
        const done = questions.map((x, i) => answerFor(x, all[i] ?? [], nextOther[i] ?? ""));
        setActive(nextUnanswered(qi, done));
      } else {
        setActive(qi);
      }
    },
    [questions, picks, other, nextUnanswered],
  );

  const send = useCallback(async () => {
    if (!canSend) return;
    const body: Record<string, Answer> = {};
    const summary: string[] = [];
    questions.forEach((q, i) => {
      const a = answers[i];
      if (a === undefined) return;
      body[q.question] = a;
      summary.push(`${q.header}: ${Array.isArray(a) ? a.join(", ") : a}`);
    });
    setSending(true);
    setError(null);
    try {
      await onAnswer({ answer: summary.join(" · "), answers: body });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transmit failed");
      setSending(false);
    }
  }, [canSend, questions, answers, onAnswer]);

  const activeQ = questions[active];
  const keyCount = Math.min(4, activeQ?.options.length ?? 0);

  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const inCard =
        e.target instanceof Element &&
        e.target.closest(`[data-decision="${decision.id}"]`) !== null;
      if (e.key === "Enter" && !e.shiftKey) {
        if (isTyping(e.target) && !inCard) return;
        e.preventDefault();
        void send();
        return;
      }
      if (isTyping(e.target)) return;
      // Tab steps between questions only when focus is nowhere in particular or already in this
      // card; elsewhere on the page it keeps its normal focus behaviour.
      if (e.key === "Tab" && (e.target === document.body || inCard) && questions.length > 1) {
        e.preventDefault();
        const step = e.shiftKey ? -1 : 1;
        setActive((a) => (a + step + questions.length) % questions.length);
        return;
      }
      const n = Number.parseInt(e.key, 10);
      if (n >= 1 && n <= keyCount) {
        e.preventDefault();
        pick(active, n - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkeys, send, keyCount, pick, active, questions.length, decision.id]);

  return (
    <section
      className="card card--ask"
      data-source={decision.source}
      data-urgency={decision.urgency}
      data-hotkeys={hotkeys}
      data-decision={decision.id}
      aria-label={title}
    >
      <CardHead
        title={title}
        decision={decision}
        via={via}
        keysTag={
          hotkeys &&
          keyCount > 0 && (
            <span className="tag">
              KEYS 1-{keyCount}
              {questions.length > 1 ? " TAB" : ""}
            </span>
          )
        }
      />

      <ContextBlock decision={decision} open={Boolean(roomy)} />

      {questions.map((q, qi) => {
        const shown = preview?.q === qi ? q.options[preview.i]?.preview : undefined;
        return (
          <fieldset
            key={q.question}
            className="ask"
            data-active={hotkeys && qi === active ? "" : undefined}
            data-answered={answers[qi] !== undefined ? "" : undefined}
          >
            <legend className="ask__head">
              <span className="ask__chip">{q.header}</span>
              {q.multiSelect && <span className="ask__multi">PICK ANY</span>}
            </legend>
            <p className="card__q">
              <CodeText text={q.question} />
            </p>
            <div className="opts">
              {q.options.map((o, oi) => {
                const on = (picks[qi] ?? []).includes(oi);
                return (
                  <button
                    key={o.label}
                    type="button"
                    className="opt"
                    aria-pressed={on}
                    data-selected={on ? "" : undefined}
                    data-multi={q.multiSelect ? "" : undefined}
                    disabled={sending}
                    onClick={() => pick(qi, oi)}
                    onMouseEnter={() => o.preview && setPreview({ q: qi, i: oi })}
                    onMouseLeave={() => setPreview(null)}
                    onFocus={() => {
                      setActive(qi);
                      if (o.preview) setPreview({ q: qi, i: oi });
                    }}
                    onBlur={() => setPreview(null)}
                  >
                    <span className="opt__k">{oi + 1}</span>
                    {q.multiSelect && (
                      <span className="opt__box" aria-hidden="true">
                        {on ? "[x]" : "[ ]"}
                      </span>
                    )}
                    <span className="opt__label">{o.label}</span>
                    {o.description && (
                      <span className="opt__desc" title={o.description}>
                        {o.description}
                      </span>
                    )}
                    {o.preview && <span className="opt__rec opt__pv">PREVIEW</span>}
                  </button>
                );
              })}
            </div>
            {/* Previews are agent-supplied markdown or HTML: shown as plain text, never rendered. */}
            {shown && <pre className="ask__preview">{shown}</pre>}
            <label className="field">
              <span className="sr-only">Other answer for {q.header}</span>
              <input
                type="text"
                value={other[qi] ?? ""}
                disabled={sending}
                placeholder="other (type your own answer)"
                onFocus={() => setActive(qi)}
                onChange={(e) => {
                  const v = e.target.value;
                  setOther((cur) => cur.map((x, i) => (i === qi ? v : x)));
                  if (v && !q.multiSelect)
                    setPicks((cur) => cur.map((p, i) => (i === qi ? [] : p)));
                }}
              />
            </label>
          </fieldset>
        );
      })}

      <div className="card__actions">
        <span className="ask__progress">
          {answers.filter((a) => a !== undefined).length}/{questions.length} answered
        </span>
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
    </section>
  );
}
