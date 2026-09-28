import type { Database } from "bun:sqlite";
import type { Persona, PersonaColor, PersonaVoice } from "@amc/shared";
import { taglineFor } from "./voice";

export const CALLSIGNS: readonly string[] = [
  "NOVA",
  "RASCAL",
  "VOSTOK",
  "PIXEL",
  "MAGPIE",
  "KESTREL",
  "DYNAMO",
  "JUNIPER",
  "ORBIT",
  "SPROCKET",
  "COMET",
  "BANDIT",
  "WIDGET",
  "TANGO",
  "FALCON",
  "MOSS",
  "PEPPER",
  "ROOK",
  "ZEPHYR",
  "HAVOC",
  "BISCUIT",
  "QUASAR",
  "GADGET",
  "LYNX",
  "TURBO",
  "WAFFLE",
  "ECHO",
  "PISTON",
  "SABLE",
  "VECTOR",
  "NIMBUS",
  "RIVET",
  "JAVELIN",
  "OTTER",
  "CINDER",
  "BOLT",
  "HALO",
  "MARMOT",
  "DRIFT",
  "SCOUT",
];

export const COLORS: PersonaColor[] = ["amber", "green", "cyan", "magenta", "red", "blue"];
export const VOICES: PersonaVoice[] = [
  "deadpan",
  "gungho",
  "anxious",
  "noir",
  "bureaucrat",
  "pirate",
  "robot",
];

/** FNV-1a 32-bit. Stable across runtimes, good enough spread for ~40 buckets. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Pure derivation: same session id always yields the same persona, except the
 * callsign advances past any name in `takenNames` (live sessions) so two
 * stations never show the same callsign at once.
 */
export function derivePersona(sessionId: string, takenNames: Iterable<string> = []): Persona {
  const taken = new Set(takenNames);
  const h = hashString(sessionId);
  let idx = h % CALLSIGNS.length;
  for (let i = 0; i < CALLSIGNS.length && taken.has(CALLSIGNS[idx] as string); i++) {
    idx = (idx + 1) % CALLSIGNS.length;
  }
  const voice = VOICES[(h >>> 16) % VOICES.length] as PersonaVoice;
  return {
    sessionId,
    name: CALLSIGNS[idx] as string,
    spriteSeed: h,
    color: COLORS[(h >>> 8) % COLORS.length] as PersonaColor,
    voice,
    tagline: taglineFor(voice, h >>> 24),
  };
}

export class PersonaStore {
  private cache = new Map<string, Persona>();

  constructor(private db: Database) {
    const rows = this.db
      .query<{ session_id: string; json: string }, []>("SELECT * FROM personas")
      .all();
    for (const r of rows) this.cache.set(r.session_id, JSON.parse(r.json) as Persona);
  }

  get(sessionId: string): Persona | undefined {
    return this.cache.get(sessionId);
  }

  /** Persist on first sight so the callsign never changes for a session. */
  getOrCreate(sessionId: string, takenNames: Iterable<string>): Persona {
    const existing = this.cache.get(sessionId);
    if (existing) return existing;
    const persona = derivePersona(sessionId, takenNames);
    this.save(persona);
    return persona;
  }

  /** A noise session was dropped: free its callsign. */
  forget(sessionId: string) {
    this.cache.delete(sessionId);
    this.db.run("DELETE FROM personas WHERE session_id = ?", [sessionId]);
  }

  /** Used when a provisional session is merged into the real one. */
  rekey(fromSessionId: string, toSessionId: string): Persona | undefined {
    const persona = this.cache.get(fromSessionId);
    if (!persona) return undefined;
    this.cache.delete(fromSessionId);
    this.db.run("DELETE FROM personas WHERE session_id = ?", [fromSessionId]);
    const moved = { ...persona, sessionId: toSessionId };
    this.save(moved);
    return moved;
  }

  private save(persona: Persona) {
    this.cache.set(persona.sessionId, persona);
    this.db.run("INSERT OR REPLACE INTO personas (session_id, json, created_at) VALUES (?, ?, ?)", [
      persona.sessionId,
      JSON.stringify(persona),
      new Date().toISOString(),
    ]);
  }
}
