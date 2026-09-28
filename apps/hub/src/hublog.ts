import os from "node:os";

/**
 * Operator-facing stdout log, one line per event, so field debugging does not
 * need `claude --debug`. Not to be confused with log.ts, which is the mission
 * log shown in the UI.
 *
 *   09:41:02 hook      SessionStart   NOVA   ~/Code/x
 *   09:41:09 otlp      logs=3 metrics=0   NOVA
 *
 * AMC_LOG: "quiet" silences, "info" (default) one line per event, "debug" also
 * appends payload keys.
 */
export type LogLevel = "quiet" | "info" | "debug";

export function parseLogLevel(raw: string | undefined): LogLevel {
  return raw === "quiet" || raw === "debug" ? raw : "info";
}

export interface HubLogger {
  level: LogLevel;
  info(kind: string, ...cols: (string | number | undefined)[]): void;
  /** Same shape as info, printed only at AMC_LOG=debug (routine transitions). */
  debug(kind: string, ...cols: (string | number | undefined)[]): void;
  /** Same line as info, plus `extra` (typically payload keys) at debug level only. */
  event(kind: string, cols: (string | number | undefined)[], extra?: () => string): void;
}

const HOME = os.homedir();

/** ~ for the home dir so station paths fit on a line. */
export function shortPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

export function createLogger(
  level: LogLevel,
  out: (line: string) => void = console.log,
): HubLogger {
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const line = (kind: string, cols: (string | number | undefined)[]) =>
    `${stamp()} ${kind.padEnd(9)} ${cols.filter((c) => c !== undefined && c !== "").join("  ")}`;
  return {
    level,
    info(kind, ...cols) {
      if (level !== "quiet") out(line(kind, cols));
    },
    debug(kind, ...cols) {
      if (level === "debug") out(line(kind, cols));
    },
    event(kind, cols, extra) {
      if (level === "quiet") return;
      out(level === "debug" && extra ? `${line(kind, cols)}  ${extra()}` : line(kind, cols));
    },
  };
}

export const payloadKeys = (payload: unknown) => () =>
  `keys=[${payload && typeof payload === "object" ? Object.keys(payload).join(",") : ""}]`;
