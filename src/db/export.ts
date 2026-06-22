import type { DatabaseSync } from "node:sqlite";
import { sqlLit as lit } from "./d1remote.ts";

// The D1 read-slice: only what the site queries. commit_index/snapshots are
// crawler scaffolding and never leave the working database.
const SCHEMA = `DROP TABLE IF EXISTS version_events;
DROP TABLE IF EXISTS crawl_state;
DROP TABLE IF EXISTS packages;
CREATE TABLE packages (
  id              INTEGER PRIMARY KEY,
  source          TEXT NOT NULL,
  name            TEXT NOT NULL,
  latest_version  TEXT,
  latest_revision INTEGER NOT NULL DEFAULT 0,
  latest_at       INTEGER,
  event_count     INTEGER NOT NULL DEFAULT 0,
  removed_at       INTEGER,
  removed_commit   TEXT,
  renamed_to       TEXT,
  migrated_to      TEXT,
  deprecate_date   TEXT,
  deprecate_reason TEXT,
  disable_date     TEXT,
  disable_reason   TEXT,
  UNIQUE (source, name)
);
CREATE TABLE version_events (
  id            INTEGER PRIMARY KEY,
  package_id    INTEGER NOT NULL,
  version       TEXT NOT NULL,
  revision      INTEGER NOT NULL DEFAULT 0,
  introduced_at INTEGER NOT NULL,
  commit_sha    TEXT,
  subject       TEXT,
  UNIQUE (package_id, version, revision)
);
CREATE TABLE crawl_state (
  source          TEXT PRIMARY KEY,
  last_sha        TEXT,
  last_crawled_at INTEGER NOT NULL
);
CREATE INDEX idx_events_pkg_time ON version_events (package_id, introduced_at DESC);
CREATE INDEX idx_events_time ON version_events (introduced_at DESC);
CREATE INDEX idx_packages_name ON packages (name);
`;

// Rows per INSERT. Keeps statement count low (~2k for the full catalog) so
// `wrangler d1 execute` doesn't choke parsing one statement per row.
const BATCH = 200;

function dumpTable(
  db: DatabaseSync,
  write: (chunk: string) => void,
  table: string,
  columns: string,
  sql: string,
  tuple: (row: Record<string, unknown>) => string,
): void {
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length === 0) return;
    write(`INSERT INTO ${table} (${columns}) VALUES ${buf.join(",")};\n`);
    buf = [];
  };
  for (const r of db.prepare(sql).all() as Record<string, unknown>[]) {
    buf.push(`(${tuple(r)})`);
    if (buf.length >= BATCH) flush();
  }
  flush();
}

/**
 * Emit the site-slice as self-contained SQL (schema + batched multi-row inserts) for
 * D1. A full reseed; apply with `wrangler d1 execute <db> [--local|--remote] --file
 * slice.sql`. Multi-row inserts keep this to ~2k statements; no explicit transaction
 * (remote D1 rejects BEGIN/COMMIT in a SQL file, and ~2k statements is fast anyway).
 */
export function exportSlice(db: DatabaseSync, write: (chunk: string) => void): void {
  write(SCHEMA);

  dumpTable(
    db,
    write,
    "packages",
    "id,source,name,latest_version,latest_revision,latest_at,event_count,removed_at,removed_commit,renamed_to,migrated_to,deprecate_date,deprecate_reason,disable_date,disable_reason",
    "SELECT id, source, name, latest_version, latest_revision, latest_at, event_count, removed_at, removed_commit, renamed_to, migrated_to, deprecate_date, deprecate_reason, disable_date, disable_reason FROM packages",
    (r) =>
      `${lit(r.id)},${lit(r.source)},${lit(r.name)},${lit(r.latest_version)},${lit(r.latest_revision)},${lit(r.latest_at)},${lit(r.event_count)},${lit(r.removed_at)},${lit(r.removed_commit)},${lit(r.renamed_to)},${lit(r.migrated_to)},${lit(r.deprecate_date)},${lit(r.deprecate_reason)},${lit(r.disable_date)},${lit(r.disable_reason)}`,
  );
  dumpTable(
    db,
    write,
    "version_events",
    "package_id,version,revision,introduced_at,commit_sha,subject",
    "SELECT package_id, version, revision, introduced_at, commit_sha, subject FROM version_events",
    (r) =>
      `${lit(r.package_id)},${lit(r.version)},${lit(r.revision)},${lit(r.introduced_at)},${lit(r.commit_sha)},${lit(r.subject)}`,
  );
  dumpTable(
    db,
    write,
    "crawl_state",
    "source,last_sha,last_crawled_at",
    "SELECT source, last_sha, last_crawled_at FROM crawl_state",
    (r) => `${lit(r.source)},${lit(r.last_sha)},${lit(r.last_crawled_at)}`,
  );
}
