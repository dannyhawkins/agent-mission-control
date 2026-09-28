import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { play } from "../audio/synth";
import { MessageError } from "../hub/errors";

const MAX_LINES = 4;

/**
 * Free-form line into the session ("new topic", a comment), for when there is no card to answer.
 * Lives inside the Station, which stays mounted while hidden in focus mode, so the draft survives
 * focus switches. Card hotkeys already ignore key presses from a textarea, so typing digits here
 * never answers a card.
 */
export function MessageBox({
  sessionName,
  onSend,
}: {
  sessionName: string;
  onSend: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the text up to MAX_LINES, then scroll.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const cs = getComputedStyle(el);
    const line = Number.parseFloat(cs.lineHeight) || 18;
    const padY = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
    const border = el.offsetHeight - el.clientHeight; // box-sizing is border-box
    // Empty: one line, even if the placeholder would wrap in a narrow station.
    const content = text ? Math.min(el.scrollHeight, line * MAX_LINES + padY) : line + padY;
    el.style.height = `${content + border}px`;
  }, [text]);

  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(false), 1500);
    return () => clearTimeout(t);
  }, [sent]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(body);
      setText("");
      setSent(true);
      play("chip");
    } catch (e) {
      setError(
        e instanceof MessageError && e.kind === "unreachable"
          ? "Couldn't reach the session."
          : e instanceof Error
            ? e.message
            : "Send failed",
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="msg" data-sent={sent ? "" : undefined}>
      <span className="msg__lbl" aria-hidden="true">
        TRANSMIT
      </span>
      <div className="msg__field">
        <textarea
          ref={ref}
          rows={1}
          maxLength={4000}
          value={text}
          disabled={sending}
          aria-label={`Message ${sessionName}`}
          placeholder="message this session (new topic, comment…)"
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {sent && (
          <span className="msg__flash" role="status">
            TRANSMITTED
          </span>
        )}
      </div>
      {error && (
        <span className="msg__err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
