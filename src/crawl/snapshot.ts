import type { DatabaseSync } from "node:sqlite";
import { batchCat } from "../git.ts";
import { extractVersion } from "../parse/extract.ts";
import { type Lifecycle, parseLifecycle } from "../parse/lifecycle.ts";
import type { Source } from "../sources/index.ts";

interface CommitRow {
  id: number;
  package_id: number;
  name: string;
  commit_sha: string;
  blob_sha: string;
  committed_at: number;
  subject: string;
  status: string;
}

const CHUNK = 20000;

/**
 * L1 — parse the blob at each indexed commit into a version snapshot. Processed in
 * id-ordered chunks so blob reads (one batched `git cat-file` per chunk) and memory
 * stay bounded at full-catalog scale.
 */
export function buildSnapshots(
  db: DatabaseSync,
  source: Source,
  onProgress?: (done: number, total: number) => void,
): number {
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM commit_index ci JOIN packages p ON p.id = ci.package_id
          WHERE p.source = ?`,
      )
      .get(source.id) as { c: number }
  ).c;

  const select = db.prepare(
    `SELECT ci.id, ci.package_id, p.name, ci.commit_sha, ci.blob_sha, ci.committed_at, ci.subject, ci.status
       FROM commit_index ci JOIN packages p ON p.id = ci.package_id
      WHERE p.source = ? AND ci.id > ?
      ORDER BY ci.id
      LIMIT ?`,
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO snapshots (package_id, commit_sha, committed_at, version, revision, version_src)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  let lastId = 0;
  let processed = 0;
  let written = 0;
  // Latest live blob per package wins → its deprecate!/disable! state is the current
  // one. Tracked across chunks (id order isn't time order) and flushed to packages
  // at the end; lives only on packages, never the per-snapshot rows.
  const lifecycle = new Map<number, { at: number; info: Lifecycle }>();

  for (;;) {
    const rows = select.all(source.id, lastId, CHUNK) as unknown as CommitRow[];
    const last = rows[rows.length - 1];
    if (!last) break;
    lastId = last.id;

    const live = rows.filter((r) => r.status !== "D" && !/^0+$/.test(r.blob_sha));
    const blobs = batchCat(
      source.repoDir,
      live.map((r) => r.blob_sha),
    );

    db.exec("BEGIN");
    for (const row of live) {
      const blob = blobs.get(row.blob_sha);
      if (blob === undefined) continue;

      const { version, revision, versionSrc } = extractVersion(
        source.kind,
        row.name,
        row.subject,
        blob,
      );
      insert.run(row.package_id, row.commit_sha, row.committed_at, version, revision, versionSrc);
      written += 1;

      const seen = lifecycle.get(row.package_id);
      if (!seen || row.committed_at > seen.at) {
        lifecycle.set(row.package_id, { at: row.committed_at, info: parseLifecycle(blob) });
      }
    }
    db.exec("COMMIT");

    processed += rows.length;
    onProgress?.(processed, total);
  }

  const setLifecycle = db.prepare(
    "UPDATE packages SET lifecycle = ?, lifecycle_date = ?, lifecycle_reason = ? WHERE id = ?",
  );
  db.exec("BEGIN");
  for (const [pid, { info }] of lifecycle) {
    setLifecycle.run(info.state, info.date, info.reason, pid);
  }
  db.exec("COMMIT");

  return written;
}
