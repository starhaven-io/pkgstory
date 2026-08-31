import type { DatabaseSync } from "node:sqlite";
import type { Source } from "../sources/index.ts";

interface SnapRow {
  version: string | null;
  revision: number;
  bottled: number;
  committed_at: number;
  commit_sha: string;
  subject: string;
}

/**
 * L2 — collapse snapshots into the version timeline. Walking oldest→newest, a row
 * is emitted only when (version, revision) changes, so bottle rebuilds and metadata
 * commits drop out and `introduced_at` is the first appearance of each version.
 */
export function buildEvents(db: DatabaseSync, source: Source): number {
  const pkgs = db.prepare("SELECT id FROM packages WHERE source = ?").all(source.id) as {
    id: number;
  }[];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO version_events
       (package_id, version, revision, introduced_at, commit_sha, subject)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertChange = db.prepare(
    "INSERT OR IGNORE INTO version_changes (package_id, commit_sha) VALUES (?, ?)",
  );
  const insertBottle = db.prepare(
    `INSERT OR IGNORE INTO bottle_events
       (package_id, bottled, version, revision, changed_at, commit_sha, subject)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // id DESC on the timestamp tie: rows were inserted in git-log order (newest
  // first), so within one second a *larger* id is the *older* commit.
  const snaps = db.prepare(
    `SELECT s.version, s.revision, s.bottled, s.committed_at, s.commit_sha, ci.subject
       FROM snapshots s JOIN commit_index ci
         ON ci.package_id = s.package_id AND ci.commit_sha = s.commit_sha
      WHERE s.package_id = ?
      ORDER BY s.committed_at ASC, s.id DESC`,
  );
  let events = 0;

  db.exec("BEGIN");
  db.prepare(
    `DELETE FROM bottle_events
      WHERE package_id IN (SELECT id FROM packages WHERE source = ?)`,
  ).run(source.id);
  for (const pkg of pkgs) {
    const rows = snaps.all(pkg.id) as unknown as SnapRow[];
    let lastKey: string | null = null;
    let lastBottled: boolean | null = null;
    for (const row of rows) {
      const bottled = row.bottled !== 0;
      if ((lastBottled === null && bottled) || (lastBottled !== null && bottled !== lastBottled)) {
        insertBottle.run(
          pkg.id,
          bottled ? 1 : 0,
          row.version,
          row.revision,
          row.committed_at,
          row.commit_sha,
          row.subject,
        );
      }
      lastBottled = bottled;
      if (!row.version) continue;
      const key = `${row.version}\x00${row.revision}`;
      if (key !== lastKey) {
        lastKey = key;
        insertChange.run(pkg.id, row.commit_sha);
        const r = insert.run(
          pkg.id,
          row.version,
          row.revision,
          row.committed_at,
          row.commit_sha,
          row.subject,
        );
        events += Number(r.changes);
      }
    }
  }
  db.exec("COMMIT");
  return events;
}
