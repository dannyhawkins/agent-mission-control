import fs from "node:fs";

/**
 * Context for a decision card, so the operator can decide without switching to
 * the terminal: the user's last prompt and what Claude said just before asking.
 *
 * Read from the session transcript (JSONL, one record per content block on
 * 2.1.280). Only the tail is read and everything is best effort: any problem
 * means no context, never an error.
 */

const TAIL_BYTES = 256 * 1024;
const PROMPT_CHARS = 600;
const ASSISTANT_CHARS = 1500;
const PREVIEW_LINES = 120;

export interface RecentContext {
  lastPrompt?: string;
  assistantText?: string;
}

interface Rec {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  /** Set on injected user turns: task notifications, peer (cross-session) messages. */
  origin?: unknown;
  message?: { role?: string; content?: unknown };
}

type Block = { type?: string; text?: string; name?: string };

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const clean = (s: string) => s.replace(ANSI, "").replace(/\r\n?/g, "\n").trim();
const head = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}...` : s);
const tail = (s: string, n: number) => (s.length > n ? `...${s.slice(-n).trimStart()}` : s);

/** Wrapped or synthetic user turns that are not something the user typed. */
function isTypedPrompt(text: string): boolean {
  const t = text.trimStart();
  return (
    t.length > 0 &&
    !t.startsWith("<") && // <command-name>, <local-command-stdout>, <system-reminder>, <cross-session-message>
    !t.startsWith("Another Claude session sent a message:") &&
    !t.startsWith("[Request interrupted")
  );
}

function userPromptText(r: Rec): string | undefined {
  if (r.type !== "user" || r.isMeta || r.isSidechain || r.origin) return undefined;
  const c = r.message?.content;
  if (typeof c === "string") return isTypedPrompt(c) ? c : undefined;
  if (!Array.isArray(c) || c.some((b: Block) => b?.type === "tool_result")) return undefined;
  const text = (c as Block[])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
  return isTypedPrompt(text) ? text : undefined;
}

function blocks(r: Rec): Block[] {
  const c = r.message?.content;
  return Array.isArray(c)
    ? (c as Block[])
    : typeof c === "string"
      ? [{ type: "text", text: c }]
      : [];
}

function readTail(file: string): Rec[] {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    if (len < size) lines.shift(); // partial first line
    const out: Rec[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as Rec);
      } catch {
        // torn line
      }
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * `toolName`: the call that triggered the card; the assistant text is the run
 * of text blocks right before its latest tool_use. `assistantText` (Stop's
 * last_assistant_message) is used as-is instead.
 */
export function recentContext(
  transcriptPath: string | undefined,
  opts: {
    toolName?: string;
    assistantText?: string;
    /** A subagent's own transcript: every record there is a sidechain record. */
    sidechain?: boolean;
  } = {},
): RecentContext | undefined {
  const out: RecentContext = {};
  if (opts.assistantText?.trim())
    out.assistantText = tail(clean(opts.assistantText), ASSISTANT_CHARS);
  if (!transcriptPath) return out.assistantText ? out : undefined;
  try {
    const recs = readTail(transcriptPath).filter((r) => opts.sidechain || !r.isSidechain);
    for (let i = recs.length - 1; i >= 0; i--) {
      const p = userPromptText(recs[i] as Rec);
      if (p) {
        out.lastPrompt = head(clean(p), PROMPT_CHARS);
        break;
      }
    }
    if (!out.assistantText) {
      // Latest tool_use of that tool (or the end, if it is not written yet).
      let i = recs.length - 1;
      if (opts.toolName) {
        for (let j = recs.length - 1; j >= 0; j--) {
          if (
            blocks(recs[j] as Rec).some((b) => b.type === "tool_use" && b.name === opts.toolName)
          ) {
            i = j - 1;
            break;
          }
        }
      }
      const texts: string[] = [];
      for (; i >= 0; i--) {
        const r = recs[i] as Rec;
        if (r.type === "user") break;
        if (r.type !== "assistant") continue;
        const bs = blocks(r);
        if (texts.length && bs.some((b) => b.type === "tool_use")) break;
        for (const b of [...bs].reverse()) {
          if (b.type === "text" && b.text?.trim()) texts.unshift(b.text);
        }
      }
      if (texts.length) out.assistantText = tail(clean(texts.join("\n\n")), ASSISTANT_CHARS);
    }
  } catch {
    // unreadable transcript: whatever we have
  }
  return out.lastPrompt || out.assistantText ? out : undefined;
}

// ─── change preview for gated edits ─────────────────────────────────────

export interface ChangePreview {
  filePath: string;
  diff: string;
  truncated: boolean;
}

const lines = (s: unknown) => (typeof s === "string" ? s.replace(/\r\n?/g, "\n").split("\n") : []);

/** Old/new hunk with shared leading and trailing lines shown as up to 3 lines of context. */
function hunk(oldStr: unknown, newStr: unknown): string[] {
  const a = lines(oldStr);
  const b = lines(newStr);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (
    post < a.length - pre &&
    post < b.length - pre &&
    a[a.length - 1 - post] === b[b.length - 1 - post]
  ) {
    post++;
  }
  const ctx = (xs: string[]) => xs.map((l) => ` ${l}`);
  return [
    "@@",
    ...ctx(a.slice(Math.max(0, pre - 3), pre)),
    ...a.slice(pre, a.length - post).map((l) => `-${l}`),
    ...b.slice(pre, b.length - post).map((l) => `+${l}`),
    ...ctx(a.slice(a.length - post, Math.min(a.length, a.length - post + 3))),
  ];
}

/** For the gated file tools; undefined for anything else or unreadable input. */
export function changePreview(tool: string, input: unknown): ChangePreview | undefined {
  if (!input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  const filePath = String(i.file_path ?? i.notebook_path ?? "");
  if (!filePath) return undefined;
  let out: string[];
  switch (tool) {
    case "Edit":
      out = hunk(i.old_string, i.new_string);
      break;
    case "MultiEdit":
      out = (Array.isArray(i.edits) ? i.edits : []).flatMap((e: Record<string, unknown>) =>
        hunk(e?.old_string, e?.new_string),
      );
      break;
    case "NotebookEdit":
      out = [
        `@@ cell ${String(i.cell_id ?? "new")} (${String(i.edit_mode ?? "replace")})`,
        ...lines(i.new_source).map((l) => `+${l}`),
      ];
      break;
    case "Write": {
      let exists = false;
      try {
        exists = fs.existsSync(filePath);
      } catch {
        // unknown: say new
      }
      out = [
        exists ? "overwrite (file exists)" : "new file",
        ...lines(i.content).map((l) => `+${l}`),
      ];
      break;
    }
    default:
      return undefined;
  }
  const truncated = out.length > PREVIEW_LINES;
  return { filePath, diff: out.slice(0, PREVIEW_LINES).join("\n"), truncated };
}
