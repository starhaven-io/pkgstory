import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(resolve(here, "schema.sql"), "utf8"));
  migrate(db);
  return db;
}

// Bring pre-existing databases up to the current schema. CREATE IF NOT EXISTS
// can't add columns to an existing table, so add them idempotently here.
function migrate(db: DatabaseSync): void {
  for (const stmt of [
    "ALTER TABLE packages ADD COLUMN latest_version TEXT",
    "ALTER TABLE packages ADD COLUMN latest_revision INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE packages ADD COLUMN latest_at INTEGER",
    "ALTER TABLE packages ADD COLUMN event_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE packages ADD COLUMN removed_at INTEGER",
    "ALTER TABLE packages ADD COLUMN removed_commit TEXT",
    "ALTER TABLE packages ADD COLUMN lifecycle TEXT",
    "ALTER TABLE packages ADD COLUMN lifecycle_date TEXT",
    "ALTER TABLE packages ADD COLUMN lifecycle_reason TEXT",
  ]) {
    try {
      db.exec(stmt);
    } catch {
      // column already exists
    }
  }
}

export function upsertPackage(db: DatabaseSync, source: string, name: string): number {
  db.prepare("INSERT OR IGNORE INTO packages (source, name) VALUES (?, ?)").run(source, name);
  const row = db
    .prepare("SELECT id FROM packages WHERE source = ? AND name = ?")
    .get(source, name) as { id: number };
  return row.id;
}

/** Refresh each package's denormalized current state from its version events. */
export function finalizeLatest(db: DatabaseSync, source: string): void {
  db.prepare(
    `UPDATE packages
        SET latest_version  = (SELECT version       FROM version_events ve WHERE ve.package_id = packages.id ORDER BY introduced_at DESC, id DESC LIMIT 1),
            latest_revision = COALESCE((SELECT revision FROM version_events ve WHERE ve.package_id = packages.id ORDER BY introduced_at DESC, id DESC LIMIT 1), 0),
            latest_at       = (SELECT introduced_at FROM version_events ve WHERE ve.package_id = packages.id ORDER BY introduced_at DESC, id DESC LIMIT 1),
            event_count     = (SELECT COUNT(*)      FROM version_events ve WHERE ve.package_id = packages.id)
      WHERE source = ?`,
  ).run(source);
}

export function getLastSha(db: DatabaseSync, source: string): string | null {
  const row = db.prepare("SELECT last_sha FROM crawl_state WHERE source = ?").get(source) as
    | { last_sha: string | null }
    | undefined;
  return row?.last_sha ?? null;
}

export function setCrawlState(db: DatabaseSync, source: string, sha: string, at: number): void {
  db.prepare(
    `INSERT INTO crawl_state (source, last_sha, last_crawled_at) VALUES (?, ?, ?)
     ON CONFLICT (source) DO UPDATE SET last_sha = excluded.last_sha, last_crawled_at = excluded.last_crawled_at`,
  ).run(source, sha, at);
}
