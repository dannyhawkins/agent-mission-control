import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * Everything is stored as JSON blobs keyed by id. The hub keeps sessions and
 * decisions in memory and writes through, so the db only needs to be a durable
 * mirror plus a queryable log. Migrations are just CREATE IF NOT EXISTS; if a
 * shape changes incompatibly, bump the file name (amc.db -> amc2.db).
 */
export function openDb(dataDir: string): Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "amc.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personas (
      session_id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS decisions_session ON decisions(session_id);
    CREATE TABLE IF NOT EXISTS log (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS log_at ON log(at);
    CREATE INDEX IF NOT EXISTS log_session ON log(session_id);
    CREATE TABLE IF NOT EXISTS activity (
      session_id TEXT NOT NULL,
      at TEXT NOT NULL,
      line TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS activity_session ON activity(session_id, at);
  `);
  return db;
}
