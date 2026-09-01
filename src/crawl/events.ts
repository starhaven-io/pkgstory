import type { DatabaseSync } from "node:sqlite";
import type { Source } from "../sources/index.ts";

interface SnapRow {
  version: string | null;
  revision: number;
  bottled: number;
  bottle_tags: string;
  committed_at: number;
  commit_sha: string;
  subject: string;
}

/**
 * L2 — collapse snapshots into the version timeline and per-platform bottle
 * intervals. Walking oldest→newest drops bottle rebuilds and metadata commits.
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
  const insertBottleInterval = db.prepare(
    `INSERT OR IGNORE INTO bottle_intervals
       (package_id, tag, started_at, started_commit, started_subject,
        started_version, started_revision)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const closeBottleInterval = db.prepare(
    `UPDATE bottle_intervals
        SET ended_at = ?, ended_commit = ?, ended_subject = ?,
            ended_version = ?, ended_revision = ?
      WHERE package_id = ? AND tag = ? AND ended_at IS NULL
        AND started_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM bottle_intervals closed
           WHERE closed.package_id = bottle_intervals.package_id
             AND closed.tag = bottle_intervals.tag
             AND closed.ended_commit = ?
        )`,
  );
  // id DESC on the timestamp tie: rows were inserted in git-log order (newest
  // first), so within one second a *larger* id is the *older* commit.
  const snaps = db.prepare(
    `SELECT s.version, s.revision, s.bottled, s.bottle_tags, s.committed_at, s.commit_sha, ci.subject
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
  db.prepare(
    `DELETE FROM bottle_intervals
      WHERE package_id IN (SELECT id FROM packages WHERE source = ?)`,
  ).run(source.id);
  for (const pkg of pkgs) {
    const rows = snaps.all(pkg.id) as unknown as SnapRow[];
    let lastKey: string | null = null;
    let lastBottled: boolean | null = null;
    let lastTags = new Set<string>();
    for (const row of rows) {
      const bottled = row.bottled !== 0;
      const tags = new Set<string>(JSON.parse(row.bottle_tags) as string[]);
      for (const tag of tags) {
        if (!lastTags.has(tag))
          insertBottleInterval.run(
            pkg.id,
            tag,
            row.committed_at,
            row.commit_sha,
            row.subject,
            row.version,
            row.revision,
          );
      }
      for (const tag of lastTags) {
        if (!tags.has(tag))
          closeBottleInterval.run(
            row.committed_at,
            row.commit_sha,
            row.subject,
            row.version,
            row.revision,
            pkg.id,
            tag,
            row.committed_at,
            row.commit_sha,
          );
      }
      lastTags = tags;
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
