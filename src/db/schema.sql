PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS packages (
  id              INTEGER PRIMARY KEY,
  source          TEXT NOT NULL,
  name            TEXT NOT NULL,
  -- Denormalized current state: avoids a version_events subquery on every index
  -- render, and gives the incremental crawl its per-package baseline to diff against.
  latest_version  TEXT,
  latest_revision INTEGER NOT NULL DEFAULT 0,
  latest_at       INTEGER,
  -- Denormalized count of version_events: lets the search-index build avoid a
  -- full events join (a per-render scan of the whole catalog otherwise).
  event_count     INTEGER NOT NULL DEFAULT 0,
  -- End-of-life state. removed_at is set (with the deleting commit) once the file is
  -- gone from the tap at HEAD. deprecate_/disable_ mirror the latest live blob's
  -- deprecate!/disable! stanzas verbatim (date may be future/scheduled); the *current*
  -- state — deprecated/disabled/active — is derived from these against today at read
  -- time, so a scheduled package flips on its own without a re-crawl.
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

-- L0: every commit that touched a package's file. The expensive, once-only pass;
-- stores blob_sha so L1/rich derivation never re-walks history.
CREATE TABLE IF NOT EXISTS commit_index (
  id           INTEGER PRIMARY KEY,
  package_id   INTEGER NOT NULL REFERENCES packages (id),
  commit_sha   TEXT NOT NULL,
  blob_sha     TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  author       TEXT,
  subject      TEXT,
  status       TEXT,
  UNIQUE (package_id, commit_sha)
);

-- L1: parsed snapshot of the file at each commit. Lean columns now; rich columns
-- (url, sha256, deps, bottles…) get added here later without reshaping anything.
CREATE TABLE IF NOT EXISTS snapshots (
  id           INTEGER PRIMARY KEY,
  package_id   INTEGER NOT NULL REFERENCES packages (id),
  commit_sha   TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  version      TEXT,
  revision     INTEGER NOT NULL DEFAULT 0,
  version_src  TEXT,
  UNIQUE (package_id, commit_sha)
);

-- L2: the deduped version timeline — one row per (version, revision) change.
CREATE TABLE IF NOT EXISTS version_events (
  id            INTEGER PRIMARY KEY,
  package_id    INTEGER NOT NULL REFERENCES packages (id),
  version       TEXT NOT NULL,
  revision      INTEGER NOT NULL DEFAULT 0,
  introduced_at INTEGER NOT NULL,
  commit_sha    TEXT,
  subject       TEXT,
  UNIQUE (package_id, version, revision)
);

-- Per-source crawl cursor + heartbeat: last_sha drives `crawl --since`
-- (git log last_sha..HEAD), last_crawled_at powers the "last checked" display.
CREATE TABLE IF NOT EXISTS crawl_state (
  source          TEXT PRIMARY KEY,
  last_sha        TEXT,
  last_crawled_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_pkg_time ON version_events (package_id, introduced_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_time ON version_events (introduced_at DESC);
-- Reconcile-removals reads each absent package's latest commit (the deletion).
CREATE INDEX IF NOT EXISTS idx_commit_pkg_time ON commit_index (package_id, committed_at DESC);
