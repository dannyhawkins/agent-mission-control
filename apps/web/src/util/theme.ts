import type { PersonaColor, SessionStatus } from "@amc/shared";

/** Phosphor palette. Mirrors the tokens on :root in styles.css; the canvas sprite needs raw hex. */
export const PERSONA_HEX: Record<PersonaColor, string> = {
  amber: "#ffb000",
  green: "#33ff66",
  cyan: "#33e0ff",
  magenta: "#ff4fd8",
  red: "#ff3b3b",
  blue: "#4f7cff",
};

/** Darken a hex colour by factor f (0..1). */
export function shade(hex: string, f: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) * f;
  const g = ((n >> 8) & 255) * f;
  const b = (n & 255) * f;
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  working: "WORKING",
  waiting_decision: "WAITING: DECISION",
  waiting_permission: "WAITING: PERMISSION",
  // Idle means "finished its turn, ready for the next prompt": an invitation, not a problem.
  idle: "READY",
  offline: "OFFLINE",
};

/** Mix a hex colour toward white by factor f (0..1). Crew sprites use this to read as junior. */
export function lighten(hex: string, f: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const mix = (c: number) => (c + (255 - c) * f) | 0;
  return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
}
