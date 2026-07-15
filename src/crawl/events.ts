import type { DatabaseSync } from "node:sqlite";
import type { Source } from "../sources/index.ts";

interface SnapRow {
  version: string | null;
  revision: number;
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
  // id DESC on the timestamp tie: rows were inserted in git-log order (newest
  // first), so within one second a *larger* id is the *older* commit.
  const snaps = db.prepare(
    `SELECT s.version, s.revision, s.committed_at, s.commit_sha, ci.subject
       FROM snapshots s JOIN commit_index ci
         ON ci.package_id = s.package_id AND ci.commit_sha = s.commit_sha
      WHERE s.package_id = ?
      ORDER BY s.committed_at ASC, s.id DESC`,
  );
  let events = 0;

  db.exec("BEGIN");
  for (const pkg of pkgs) {
    const rows = snaps.all(pkg.id) as unknown as SnapRow[];
    let lastKey: string | null = null;
    for (const row of rows) {
      if (!row.version) continue;
      const key = `${row.version}\x00${row.revision}`;
      if (key === lastKey) continue;
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
  db.exec("COMMIT");
  return events;
}
