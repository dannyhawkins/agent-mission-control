import os from "node:os";
import path from "node:path";

/**
 * The specific target of a tool call, appended to the voiced activity line
 * ("Plundered Edit · apps/web/src/hub/state.ts") so a station's history says
 * what actually happened. Short, single line, never file contents, and with
 * anything secret-looking masked: these lines are broadcast and stored.
 */

const MAX = 80;
const HOME = os.homedir();

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const cap = (s: string, n = MAX) => (s.length > n ? `${s.slice(0, n - 3).trimEnd()}...` : s);

/** Relative to the session cwd when inside it, else ~-shortened. */
export function shortFile(p: string, cwd: string | undefined): string {
  if (cwd && (p === cwd || p.startsWith(`${cwd}/`))) return path.relative(cwd, p) || ".";
  return p.startsWith(`${HOME}/`) ? `~/${p.slice(HOME.length + 1)}` : p;
}

const SENSITIVE =
  "[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|AUTH|CREDENTIAL)[A-Za-z0-9_]*";

/**
 * Masks values that look like secrets: NAME=value for sensitive names,
 * --token/--password style flags, Authorization/Bearer headers, and URL
 * userinfo (https://user:pass@host).
 */
export function maskSecrets(s: string): string {
  return s
    .replace(new RegExp(`\\b(${SENSITIVE})=("[^"]*"|'[^']*'|\\S+)`, "gi"), "$1=***")
    .replace(
      /(--?(?:token|password|passwd|secret|api-?key|auth)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi,
      "$1***",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 ***")
    .replace(/(Authorization:\s*)[^"'\n]+/gi, "$1***")
    .replace(/(\/\/[^/\s:@]+):[^@\s/]+@/g, "$1:***@");
}

/** Target text for a tool call, or undefined when there is nothing useful to add. */
export function toolTarget(tool: string, input: unknown, cwd?: string): string | undefined {
  if (tool.startsWith("mcp__")) return tool.split("__").pop() || undefined;
  if (!input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  const str = (k: string) =>
    typeof i[k] === "string" && (i[k] as string).trim() ? (i[k] as string) : undefined;
  let out: string | undefined;
  switch (tool) {
    case "Bash":
    case "BashOutput": {
      const desc = str("description");
      const cmd = str("command");
      out = desc ? oneLine(desc) : cmd ? cap(oneLine(maskSecrets(cmd)), 60) : undefined;
      break;
    }
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const f = str("file_path") ?? str("notebook_path");
      out = f ? shortFile(f, cwd) : undefined;
      break;
    }
    case "Grep": {
      const pattern = str("pattern");
      const where = str("path") ?? str("glob");
      out = pattern
        ? `"${oneLine(pattern)}"${where ? ` in ${shortFile(where, cwd)}` : ""}`
        : undefined;
      break;
    }
    case "Glob": {
      const pattern = str("pattern");
      const where = str("path");
      out = pattern ? `${pattern}${where ? ` in ${shortFile(where, cwd)}` : ""}` : undefined;
      break;
    }
    case "WebFetch": {
      const url = str("url");
      out = url
        ? maskSecrets(url)
            .replace(/^https?:\/\//, "")
            .replace(/[?#].*$/, "")
        : undefined;
      break;
    }
    case "WebSearch": {
      const q = str("query");
      out = q ? `"${oneLine(q)}"` : undefined;
      break;
    }
    case "Task":
    case "Agent":
      out = str("description") ?? str("subagent_type");
      break;
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      out = str("subject") ?? str("description");
      break;
    default:
      out = undefined;
  }
  return out ? cap(oneLine(out)) : undefined;
}

/** "voiced phrase · target", or just the phrase. */
export function withTarget(line: string, target: string | undefined): string {
  return target ? `${line} · ${target}` : line;
}
