import type { Decision } from "@amc/shared";
import { CodeText } from "./DecisionCard";

/** Below this, a question alone rarely says enough to decide without the terminal. */
const THIN_QUESTION = 120;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * What the session was doing when it asked: Claude's text just before the question and the
 * operator's last prompt. Opens by default only when the card itself says little, so a
 * well-described question is not buried under transcript. Everything renders as text.
 */
export function ContextBlock({
  decision,
  skipAssistant = false,
  open,
}: {
  decision: Decision;
  /** Prose cards already show Claude's message in full. */
  skipAssistant?: boolean;
  /** Overrides the thin-question rule (ask cards carry their own option descriptions). */
  open?: boolean;
}) {
  const rc = decision.recentContext;
  const assistant = skipAssistant ? undefined : rc?.assistantText?.trim();
  const prompt = rc?.lastPrompt?.trim();
  if (!assistant && !prompt) return null;
  const thin = open ?? (decision.question.length < THIN_QUESTION && !decision.context);

  return (
    <div className="ctxb">
      {assistant && (
        <details className="ctxb__item" open={thin}>
          <summary>
            <span className="ctxb__lbl">CONTEXT</span>
            <span className="ctxb__peek">{oneLine(assistant)}</span>
          </summary>
          <div className="ctxb__text">
            <CodeText text={assistant} />
          </div>
        </details>
      )}
      {prompt && (
        <details className="ctxb__item ctxb__item--prompt">
          <summary>
            <span className="ctxb__you">You asked:</span>
            <span className="ctxb__peek">{oneLine(prompt)}</span>
          </summary>
          <div className="ctxb__text">
            <CodeText text={prompt} />
          </div>
        </details>
      )}
    </div>
  );
}

function lineKind(line: string): string | undefined {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return undefined;
}

/** Gated Edit/Write: the file and the change, so Allow is an informed click. */
export function DiffPreview({ preview }: { preview: NonNullable<Decision["changePreview"]> }) {
  const lines = preview.diff.replace(/\n$/, "").split("\n");
  return (
    <div className="diffb">
      <div className="diffb__path" title={preview.filePath}>
        {preview.filePath}
      </div>
      <pre className="diffb__body">
        {lines.map((line, i) => (
          <span key={i} className="diffb__line" data-kind={lineKind(line)}>
            {line || " "}
          </span>
        ))}
        {preview.truncated && <span className="diffb__more">…truncated</span>}
      </pre>
    </div>
  );
}

/** The exact shell command a Bash permission would run, wrapped in full. */
export function commandOf(d: Decision): string | undefined {
  if (d.source !== "permission" || d.toolName !== "Bash") return undefined;
  const cmd = (d.toolInput as { command?: unknown } | undefined)?.command;
  return typeof cmd === "string" ? cmd : undefined;
}
