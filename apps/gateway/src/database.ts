import Database from "better-sqlite3";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  normalizePreferences,
  type Camera,
  type Preferences,
} from "@homegrid/shared";

export function openDatabase(stateDir: string) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const path = join(stateDir, "homegrid.sqlite");
  const db = new Database(path);
  chmodSync(path, 0o600);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS homegrid_preferences (user_id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS homegrid_media (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, location TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS homegrid_media_session ON homegrid_media(session_id);
    CREATE TABLE IF NOT EXISTS homegrid_limit (key TEXT PRIMARY KEY, count INTEGER NOT NULL, starts INTEGER NOT NULL);
  `);
  return db;
}
export function getPreferences(
  db: Database.Database,
  user: string,
  cameras: Camera[],
): Preferences {
  const row = db
    .prepare("SELECT value FROM homegrid_preferences WHERE user_id = ?")
    .get(user) as { value: string } | undefined;
  try {
    return normalizePreferences(row ? JSON.parse(row.value) : null, cameras);
  } catch {
    return normalizePreferences(null, cameras);
  }
}
export function savePreferences(
  db: Database.Database,
  user: string,
  preferences: Preferences,
) {
  db.prepare(
    "INSERT INTO homegrid_preferences(user_id, value) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET value = excluded.value",
  ).run(user, JSON.stringify(preferences));
}
// One household-wide budget cannot be evaded by spoofing forwarded IP headers.
export function consumeLimit(
  db: Database.Database,
  key: string,
  max: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  return db
    .transaction(() => {
      const row = db
        .prepare("SELECT count, starts FROM homegrid_limit WHERE key = ?")
        .get(key) as { count: number; starts: number } | undefined;
      if (!row || now - row.starts >= windowMs) {
        db.prepare(
          "INSERT INTO homegrid_limit VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, starts = excluded.starts",
        ).run(key, now);
        return true;
      }
      if (row.count >= max) return false;
      db.prepare(
        "UPDATE homegrid_limit SET count = count + 1 WHERE key = ?",
      ).run(key);
      return true;
    })
    .immediate();
}
