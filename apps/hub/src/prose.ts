import fs from "node:fs";

/** Blocking Stop reason, verbatim from the product spec (plus the self-contained-question guidance). Phrased for Claude, never names the hub. */
export const NUDGE_REASON =
  "Before you stop: your reply leaves questions for the user. Ask them with the AskUserQuestion tool instead (one question each, 2 to 4 options, recommended option first, include enough context in the question text), so the user can answer from their dashboard. If nothing actually needs the user's answer, just stop. Write each question so it makes sense on its own without the terminal: say what you found and why it matters, and put the consequence of each choice in the option description.";

const MAX_QUESTIONS = 4;
/** How much of the final reply the prose card carries for context. */
export const PROSE_TAIL_CHARS = 1200;

/**
 * Open questions in Claude's final reply, in order, at most 4. Cheap and
 * synchronous: it runs inside a Stop hook that blocks the terminal.
 *
 * - Fenced code blocks are dropped; inline code and quoted text are masked, so
 *   a `?? 0` or a quoted "why?" never ends a sentence, then restored verbatim.
 * - Inline enumerations ("need you: 1. Which ...? 2. Can I ...?") are split
 *   into items, as are real list lines.
 * - A question is a list item or sentence whose last character is "?".
 */
export function extractQuestions(text: string): string[] {
  const masks: string[] = [];
  const mask = (s: string) => `\u0000${masks.push(s) - 1}\u0000`;
  const body = text
    .replace(/```[\s\S]*?(```|$)/g, "\n")
    .replace(/~~~[\s\S]*?(~~~|$)/g, "\n")
    .replace(/`[^`\n]*`/g, mask)
    .replace(/"[^"\n]*"|“[^”\n]*”/g, mask)
    // "...: 1. Which" / "? 2. Can" -> new line per item
    .replace(/(^|[\s:;])(\d{1,2}[.)])\s+(?=\S)/g, "$1\n$2 ");
  const unmask = (s: string) =>
    s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => masks[Number(i)] ?? "");

  const out: string[] = [];
  for (const rawLine of body.split("\n")) {
    // Emphasis goes first so "**Ship it?** Tests pass." still splits after the "?".
    const line = rawLine.replace(/\*\*|__/g, "").trim();
    if (!line) continue;
    const item = line.match(/^(?:\d{1,2}[.)]|[-*•+])\s+(.*)$/);
    const pieces = item ? [item[1] as string] : line.split(/(?<=[.!?])\s+(?=\S)/);
    for (const piece of pieces) {
      const q = piece.replace(/^#+\s*/, "").trim();
      if (q.endsWith("?") && q.length > 3) out.push(unmask(q));
    }
  }
  return [...new Set(out)].slice(0, MAX_QUESTIONS);
}

/**
 * Fallback when a Stop payload lacks last_assistant_message (older builds): the
 * last assistant text in the transcript. Reads only the tail, so it stays fast
 * on long sessions. The docs warn the final message may not be flushed yet at
 * Stop time, so this is best effort.
 */
export function lastAssistantText(transcriptPath: string, tailBytes = 256 * 1024): string {
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, tailBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n").reverse();
      for (const line of lines) {
        if (!line.includes('"assistant"')) continue;
        try {
          const rec = JSON.parse(line) as {
            type?: string;
            message?: { role?: string; content?: unknown };
          };
          if (rec.type !== "assistant" && rec.message?.role !== "assistant") continue;
          const content = rec.message?.content;
          const text = Array.isArray(content)
            ? content
                .filter((c): c is { type: string; text: string } => c?.type === "text")
                .map((c) => c.text)
                .join("\n")
            : typeof content === "string"
              ? content
              : "";
          if (text.trim()) return text;
        } catch {
          // partial first line of the tail window
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // missing or unreadable transcript
  }
  return "";
}
