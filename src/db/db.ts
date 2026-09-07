import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    const priorVersionChangeColumns = new Set(
      (db.prepare("PRAGMA table_info(version_changes)").all() as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    db.exec(readFileSync(resolve(here, "schema.sql"), "utf8"));
    migrate(db, priorVersionChangeColumns);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Open an existing crawl database without applying schema or data migrations. */
export function openReadonlyDb(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

export interface StagedDatabase {
  db: DatabaseSync;
  publish(): Promise<void>;
  discard(): void;
}

/** Build against a private clone and transactionally publish only on success. */
export async function openStagedDb(path: string): Promise<StagedDatabase> {
  if (path === ":memory:") {
    const db = openDb(path);
    let active = true;
    const close = (): void => {
      if (!active) return;
      active = false;
      db.close();
    };
    return { db, publish: async () => close(), discard: close };
  }

  const requested = resolve(path);
  const target = existsSync(requested) ? realpathSync(requested) : requested;
  const priorMode = existsSync(target) ? statSync(target).mode & 0o777 : null;
  const stagingDir = mkdtempSync(join(dirname(target), ".pkgstory-staging-"));
  const stagingPath = join(stagingDir, basename(target));
  try {
    if (existsSync(target)) {
      const source = new DatabaseSync(target);
      try {
        await backup(source, stagingPath);
      } finally {
        source.close();
      }
    }
    if (priorMode !== null) chmodSync(stagingPath, priorMode);
    const db = openDb(stagingPath);
    let active = true;
    const close = (): void => {
      if (!active) return;
      active = false;
      db.close();
    };
    return {
      db,
      async publish(): Promise<void> {
        const source = active ? db : new DatabaseSync(stagingPath);
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          if (source === db) close();
          else source.close();
        };
        try {
          assertTargetCanBeReplaced(target);
          await backup(source, target);
          release();
        } catch (cause) {
          try {
            release();
          } catch {
            // Preserve the publication error and the staged directory for recovery.
          }
          const detail = cause instanceof Error ? `: ${cause.message}` : "";
          throw new Error(
            `failed to publish ${target}; completed staged database retained at ${stagingPath}${detail}`,
            { cause },
          );
        }
        rmSync(stagingDir, { recursive: true, force: true });
      },
      discard(): void {
        close();
        rmSync(stagingDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function assertTargetCanBeReplaced(target: string): void {
  const walPath = `${target}-wal`;
  const shmPath = `${target}-shm`;
  const wal = statSync(walPath, { throwIfNoEntry: false });
  if (wal && wal.size > 0) {
    throw new Error(`refusing to publish while ${walPath} contains ${wal.size} bytes`);
  }

  const sidecars = [walPath, shmPath];
  if (!sidecars.some(existsSync)) return;
  if (!existsSync(target)) {
    throw new Error(`refusing to publish missing target ${target} while SQLite sidecars exist`);
  }

  try {
    const probe = new DatabaseSync(target);
    try {
      probe.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    } finally {
      probe.close();
    }
  } catch (cause) {
    throw new Error(`could not verify empty SQLite sidecars for ${target}`, { cause });
  }

  const remaining = sidecars.filter(existsSync);
  if (remaining.length > 0) {
    throw new Error(
      `refusing to publish while SQLite sidecars remain active or ambiguous (${remaining.join(", ")})`,
    );
  }
}

// Bring pre-existing databases up to the current schema. CREATE IF NOT EXISTS
// can't add columns to an existing table, so add them idempotently here.
function migrate(db: DatabaseSync, priorVersionChangeColumns: Set<string>): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS version_changes (
      package_id INTEGER NOT NULL,
      commit_sha TEXT NOT NULL,
      version TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      changed_at INTEGER NOT NULL,
      history_order INTEGER NOT NULL DEFAULT 0,
      subject TEXT,
      PRIMARY KEY (package_id, commit_sha),
      FOREIGN KEY (package_id, commit_sha) REFERENCES commit_index (package_id, commit_sha)
    )`);
    const versionChangeHistoryOrder =
      "ALTER TABLE version_changes ADD COLUMN history_order INTEGER NOT NULL DEFAULT 0";
    let addedVersionChangeHistoryOrder = false;
    for (const stmt of [
      "ALTER TABLE packages ADD COLUMN latest_version TEXT",
      "ALTER TABLE packages ADD COLUMN latest_revision INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE packages ADD COLUMN latest_at INTEGER",
      "ALTER TABLE packages ADD COLUMN latest_bottled INTEGER CHECK (latest_bottled IN (0, 1))",
      "ALTER TABLE packages ADD COLUMN latest_bottle_tags TEXT",
      "ALTER TABLE packages ADD COLUMN event_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE packages ADD COLUMN bottle_event_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE packages ADD COLUMN bottle_interval_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE packages ADD COLUMN removed_at INTEGER",
      "ALTER TABLE packages ADD COLUMN removed_commit TEXT",
      "ALTER TABLE packages ADD COLUMN renamed_to TEXT",
      "ALTER TABLE packages ADD COLUMN migrated_to TEXT",
      "ALTER TABLE packages ADD COLUMN deprecate_date TEXT",
      "ALTER TABLE packages ADD COLUMN deprecate_reason TEXT",
      "ALTER TABLE packages ADD COLUMN disable_date TEXT",
      "ALTER TABLE packages ADD COLUMN disable_reason TEXT",
      "ALTER TABLE snapshots ADD COLUMN bottled INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE snapshots ADD COLUMN bottle_tags TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE commit_index ADD COLUMN history_order INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE bottle_intervals ADD COLUMN started_version TEXT",
      "ALTER TABLE bottle_intervals ADD COLUMN started_revision INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE bottle_intervals ADD COLUMN ended_version TEXT",
      "ALTER TABLE bottle_intervals ADD COLUMN ended_revision INTEGER",
      "ALTER TABLE version_changes ADD COLUMN version TEXT",
      "ALTER TABLE version_changes ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE version_changes ADD COLUMN changed_at INTEGER",
      versionChangeHistoryOrder,
      "ALTER TABLE version_changes ADD COLUMN subject TEXT",
    ]) {
      try {
        db.exec(stmt);
        if (stmt === versionChangeHistoryOrder) addedVersionChangeHistoryOrder = true;
      } catch (e) {
        // "duplicate column name" is the already-migrated case; anything else is real.
        if (!String(e).includes("duplicate column name")) throw e;
      }
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_commit_pkg_order ON commit_index (package_id, history_order DESC)",
    );
    if (addedVersionChangeHistoryOrder) {
      db.exec(
        `UPDATE version_changes
        SET history_order = (SELECT ci.history_order FROM commit_index ci
                              WHERE ci.package_id = version_changes.package_id
                                AND ci.commit_sha = version_changes.commit_sha)
      WHERE EXISTS (SELECT 1 FROM commit_index ci
                     WHERE ci.package_id = version_changes.package_id
                       AND ci.commit_sha = version_changes.commit_sha)`,
      );
    }
    const needsVersionChangeRecovery =
      priorVersionChangeColumns.size === 0 ||
      ["version", "revision", "changed_at", "subject"].some(
        (column) => !priorVersionChangeColumns.has(column),
      );
    if (needsVersionChangeRecovery) {
      // The original transition table stored only package + commit. Recover every
      // canonical introduction that still has both of its source rows. Reverts cannot
      // be reconstructed from the deduped version_events table and deliberately remain
      // incomplete so exportSlice can require an authoritative full crawl.
      db.exec(
        `UPDATE version_changes
        SET version = (SELECT ve.version FROM version_events ve
                        WHERE ve.package_id = version_changes.package_id
                          AND ve.commit_sha = version_changes.commit_sha),
            revision = (SELECT ve.revision FROM version_events ve
                         WHERE ve.package_id = version_changes.package_id
                           AND ve.commit_sha = version_changes.commit_sha),
            changed_at = (SELECT ve.introduced_at FROM version_events ve
                          WHERE ve.package_id = version_changes.package_id
                            AND ve.commit_sha = version_changes.commit_sha),
            subject = (SELECT ve.subject FROM version_events ve
                       WHERE ve.package_id = version_changes.package_id
                         AND ve.commit_sha = version_changes.commit_sha)
      WHERE (version IS NULL OR changed_at IS NULL)
        AND EXISTS (SELECT 1 FROM version_events ve
                    WHERE ve.package_id = version_changes.package_id
                      AND ve.commit_sha = version_changes.commit_sha);
     INSERT OR IGNORE INTO version_changes
       (package_id, commit_sha, version, revision, changed_at, history_order, subject)
     SELECT ve.package_id, ve.commit_sha, ve.version, ve.revision, ve.introduced_at,
            ci.history_order, ve.subject
       FROM version_events ve
       JOIN commit_index ci
         ON ci.package_id = ve.package_id AND ci.commit_sha = ve.commit_sha
      WHERE ve.commit_sha IS NOT NULL`,
      );
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_changes_pkg_time ON version_changes (package_id, changed_at DESC)",
    );
    db.exec("CREATE INDEX IF NOT EXISTS idx_changes_time ON version_changes (changed_at DESC)");
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_changes_pkg_order ON version_changes (package_id, history_order DESC)",
    );
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/** Remove one source's complete derived slice before an authoritative full crawl. */
export function resetSource(db: DatabaseSync, source: string): void {
  const packageIds = "SELECT id FROM packages WHERE source = ?";
  db.exec("BEGIN");
  try {
    for (const table of [
      "package_contributors",
      "commit_contributors",
      "version_changes",
      "bottle_intervals",
      "bottle_events",
      "version_events",
      "snapshots",
      "commit_index",
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE package_id IN (${packageIds})`).run(source);
    }
    db.prepare("DELETE FROM packages WHERE source = ?").run(source);
    db.prepare("DELETE FROM contributor_seeds WHERE source = ?").run(source);
    db.prepare("DELETE FROM crawl_state WHERE source = ?").run(source);
    db.exec(
      "DELETE FROM contributors WHERE NOT EXISTS (SELECT 1 FROM commit_contributors cc WHERE cc.contributor_key = contributors.contributor_key)",
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
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
        SET latest_version  = (SELECT s.version FROM snapshots s JOIN commit_index ci ON ci.package_id = s.package_id AND ci.commit_sha = s.commit_sha WHERE s.package_id = packages.id AND s.version IS NOT NULL ORDER BY ci.history_order DESC LIMIT 1),
            latest_revision = COALESCE((SELECT s.revision FROM snapshots s JOIN commit_index ci ON ci.package_id = s.package_id AND ci.commit_sha = s.commit_sha WHERE s.package_id = packages.id AND s.version IS NOT NULL ORDER BY ci.history_order DESC LIMIT 1), 0),
            latest_bottled  = (SELECT s.bottled FROM snapshots s JOIN commit_index ci ON ci.package_id = s.package_id AND ci.commit_sha = s.commit_sha WHERE s.package_id = packages.id ORDER BY ci.history_order DESC LIMIT 1),
            latest_bottle_tags = (SELECT s.bottle_tags FROM snapshots s JOIN commit_index ci ON ci.package_id = s.package_id AND ci.commit_sha = s.commit_sha WHERE s.package_id = packages.id ORDER BY ci.history_order DESC LIMIT 1),
            event_count     = (SELECT COUNT(*) FROM version_events ve WHERE ve.package_id = packages.id),
            bottle_event_count = (SELECT COUNT(*) FROM bottle_events be WHERE be.package_id = packages.id),
            bottle_interval_count = (SELECT COUNT(*) FROM bottle_intervals bi WHERE bi.package_id = packages.id)
      WHERE source = ?`,
  ).run(source);
  // latest_at is the latest transition to the shipping version, including a revert.
  db.prepare(
    `UPDATE packages
        SET latest_at = (SELECT vc.changed_at FROM version_changes vc
                          JOIN commit_index ci
                            ON ci.package_id = vc.package_id AND ci.commit_sha = vc.commit_sha
                         WHERE vc.package_id = packages.id
                         ORDER BY ci.history_order DESC LIMIT 1)
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
