import type { DatabaseSync } from "node:sqlite";
import { sqlLit as lit } from "./d1remote.ts";

// The D1 read-slice: only what the site queries. commit_index/snapshots are
// crawler scaffolding and never leave the working database.
const SCHEMA = `DROP TABLE IF EXISTS contributor_seeds;
DROP TABLE IF EXISTS package_contribution_slices;
DROP TABLE IF EXISTS contributors;
DROP TABLE IF EXISTS version_events;
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
CREATE TABLE contributors (
  contributor_key TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  github_login    TEXT,
  is_bot          INTEGER NOT NULL DEFAULT 0,
  last_seen_at    INTEGER NOT NULL
);
CREATE TABLE package_contribution_slices (
  package_id      INTEGER NOT NULL,
  contributor_key TEXT NOT NULL,
  window_start_sha TEXT NOT NULL,
  window_end_sha  TEXT NOT NULL,
  touch_count     INTEGER NOT NULL,
  version_count   INTEGER NOT NULL,
  first_at        INTEGER NOT NULL,
  last_at         INTEGER NOT NULL,
  PRIMARY KEY (package_id, contributor_key, window_start_sha)
);
CREATE TABLE contributor_seeds (
  source        TEXT PRIMARY KEY,
  seeded_at_sha TEXT NOT NULL
);
CREATE TABLE crawl_state (
  source          TEXT PRIMARY KEY,
  last_sha        TEXT,
  last_crawled_at INTEGER NOT NULL
);
CREATE INDEX idx_events_pkg_time ON version_events (package_id, introduced_at DESC);
CREATE INDEX idx_events_time ON version_events (introduced_at DESC);
CREATE INDEX idx_packages_name ON packages (name);
CREATE INDEX idx_contribution_slices_package ON package_contribution_slices (package_id);
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
    "contributors",
    "contributor_key,display_name,github_login,is_bot,last_seen_at",
    `SELECT c.contributor_key, c.display_name, c.github_login, c.is_bot, c.last_seen_at
       FROM contributors c
      WHERE c.contributor_key IN (SELECT pc.contributor_key
                                    FROM package_contributors pc
                                    JOIN packages p ON p.id = pc.package_id
                                    JOIN contributor_seeds cs ON cs.source = p.source)`,
    (r) =>
      `${lit(r.contributor_key)},${lit(r.display_name)},${lit(r.github_login)},${lit(r.is_bot)},${lit(r.last_seen_at)}`,
  );
  dumpTable(
    db,
    write,
    "package_contribution_slices",
    "package_id,contributor_key,window_start_sha,window_end_sha,touch_count,version_count,first_at,last_at",
    `SELECT pc.package_id, pc.contributor_key,
            'seed' AS window_start_sha, cs.seeded_at_sha AS window_end_sha,
            pc.touch_count, pc.version_count, pc.first_at, pc.last_at
       FROM package_contributors pc
       JOIN packages p ON p.id = pc.package_id
       JOIN contributor_seeds cs ON cs.source = p.source`,
    (r) =>
      `${lit(r.package_id)},${lit(r.contributor_key)},${lit(r.window_start_sha)},${lit(r.window_end_sha)},${lit(r.touch_count)},${lit(r.version_count)},${lit(r.first_at)},${lit(r.last_at)}`,
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
  // The marker lands last: a partial non-transactional reseed must not enable
  // incremental contributor writes on top of an incomplete historical seed.
  dumpTable(
    db,
    write,
    "contributor_seeds",
    "source,seeded_at_sha",
    "SELECT source, seeded_at_sha FROM contributor_seeds",
    (r) => `${lit(r.source)},${lit(r.seeded_at_sha)}`,
  );
}
