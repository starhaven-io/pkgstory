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
    "ALTER TABLE packages ADD COLUMN latest_bottled INTEGER CHECK (latest_bottled IN (0, 1))",
    "ALTER TABLE packages ADD COLUMN event_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE packages ADD COLUMN bottle_event_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE packages ADD COLUMN removed_at INTEGER",
    "ALTER TABLE packages ADD COLUMN removed_commit TEXT",
    "ALTER TABLE packages ADD COLUMN renamed_to TEXT",
    "ALTER TABLE packages ADD COLUMN migrated_to TEXT",
    "ALTER TABLE packages ADD COLUMN deprecate_date TEXT",
    "ALTER TABLE packages ADD COLUMN deprecate_reason TEXT",
    "ALTER TABLE packages ADD COLUMN disable_date TEXT",
    "ALTER TABLE packages ADD COLUMN disable_reason TEXT",
    "ALTER TABLE snapshots ADD COLUMN bottled INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      db.exec(stmt);
    } catch (e) {
      // "duplicate column name" is the already-migrated case; anything else is real.
      if (!String(e).includes("duplicate column name")) throw e;
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

/** Refresh each package's denormalized current state from its snapshots and events. */
export function finalizeLatest(db: DatabaseSync, source: string): void {
  // Re-introduced versions keep their original version_events row, so the shipping
  // version must come from the newest snapshot rather than the newest event.
  db.prepare(
    `UPDATE packages
        SET latest_version  = (SELECT version  FROM snapshots s WHERE s.package_id = packages.id AND s.version IS NOT NULL ORDER BY s.committed_at DESC, s.id ASC LIMIT 1),
            latest_revision = COALESCE((SELECT revision FROM snapshots s WHERE s.package_id = packages.id AND s.version IS NOT NULL ORDER BY s.committed_at DESC, s.id ASC LIMIT 1), 0),
            latest_bottled  = (SELECT bottled FROM snapshots s WHERE s.package_id = packages.id ORDER BY s.committed_at DESC, s.id ASC LIMIT 1),
            event_count     = (SELECT COUNT(*) FROM version_events ve WHERE ve.package_id = packages.id),
            bottle_event_count = (SELECT COUNT(*) FROM bottle_events be WHERE be.package_id = packages.id)
      WHERE source = ?`,
  ).run(source);
  // latest_at is when the shipping version was first introduced, not when a
  // downgrade reinstated it — the same instant the public timeline shows.
  db.prepare(
    `UPDATE packages
        SET latest_at = (SELECT ve.introduced_at FROM version_events ve
                          WHERE ve.package_id = packages.id
                            AND ve.version = packages.latest_version
                            AND ve.revision = packages.latest_revision)
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
