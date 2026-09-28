import { useState } from "react";
import { AnswerError } from "../hub/errors";
import { ContextBlock } from "./ContextBlock";
import { CardHead, type CardProps, CodeText, TITLE } from "./DecisionCard";

/**
 * Claude ended its turn with questions written as prose, so there is no tool call waiting on an
 * answer. With answerable === false (no delivery route) the card points you at the terminal and
 * offers Dismiss; otherwise it takes a free-text answer. No hotkeys: there is nothing to pick.
 */
export function ProseCard({ decision, onAnswer, onDismiss, via, roomy }: CardProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const questions = decision.prose?.questions ?? [decision.question];
  const message = decision.prose?.message;
  // A 502 means the hub could not reach the session; fall back to the terminal for this card.
  const [undeliverable, setUndeliverable] = useState(false);
  const answerable = decision.answerable !== false && !undeliverable;

  const run = async (fn: () => Promise<void>) => {
    setSending(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof AnswerError && e.kind === "undeliverable") {
        setUndeliverable(true);
        setSending(false);
        return;
      }
      setError(e instanceof Error ? e.message : "Transmit failed");
      setSending(false);
    }
  };

  return (
    <section
      className="card"
      data-source={decision.source}
      data-urgency={decision.urgency}
      data-hotkeys={false}
      data-decision={decision.id}
      aria-label={TITLE.prose}
    >
      <CardHead title={TITLE.prose} decision={decision} via={via} />

      <ol className="prose__qs">
        {questions.map((q, i) => (
          <li key={`${i}${q}`} className="card__q">
            <span className="prose__n">{i + 1}.</span>
            <span>
              <CodeText text={q} />
            </span>
          </li>
        ))}
      </ol>

      <ContextBlock
        decision={decision}
        skipAssistant={Boolean(message)}
        open={roomy || undefined}
      />

      {message && (
        <details className="card__ctx" open={roomy}>
          <summary>Claude's last message</summary>
          <pre>{message}</pre>
        </details>
      )}

      {answerable ? (
        <form
          className="card__actions"
          onSubmit={(e) => {
            e.preventDefault();
            const answer = text.trim();
            if (answer && !sending) void run(() => onAnswer({ answer }));
          }}
        >
          <label className="field">
            <span className="sr-only">Your answer</span>
            <input
              type="text"
              value={text}
              disabled={sending}
              placeholder="reply (delivered to the session)"
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn--send" disabled={sending || !text.trim()}>
            {sending ? "Sending" : "Send"}
          </button>
        </form>
      ) : (
        <div className="card__actions prose__terminal">
          <span className="prose__where">
            {undeliverable
              ? "Couldn't deliver, answer in the terminal."
              : "Answer in the terminal."}
          </span>
          <button
            type="button"
            className="btn"
            disabled={sending}
            onClick={() => void run(onDismiss)}
          >
            Dismiss
          </button>
        </div>
      )}
      {error && (
        <p className="card__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
