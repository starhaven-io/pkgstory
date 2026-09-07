import type { DatabaseSync } from "node:sqlite";
import { contributorFromIdentity } from "../contributors.ts";
import { upsertPackage } from "../db/db.ts";
import { logRaw, type RawFile, streamLog } from "../git.ts";
import type { Source } from "../sources/index.ts";
import { clearContributorLinks, contributorWriter } from "./contributors.ts";

function deletedFilesFirst(files: RawFile[]): RawFile[] {
  // A relocation can delete and add the same package in one commit. The index key
  // is package + commit, so write the live path last and retain its blob.
  return files.toSorted((a, b) => Number(b.status === "D") - Number(a.status === "D"));
}

/**
 * L0 — index every commit touching the requested packages' files. Scoped to the
 * current paths for speed; the bucket-by-basename step below is what the full-tree
 * production pass uses to stay relocation-proof.
 */
export function buildCommitIndex(
  db: DatabaseSync,
  source: Source,
  names: string[],
  ref = "HEAD",
): number {
  const wanted = new Set(names);
  const pathspecs = names.flatMap((n) => source.pathsFor(n));
  const commits = logRaw(source.repoDir, pathspecs, ref);

  const insert = db.prepare(
    `INSERT INTO commit_index
       (package_id, commit_sha, blob_sha, committed_at, history_order, author, subject, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (package_id, commit_sha) DO UPDATE SET
       committed_at = excluded.committed_at,
       history_order = excluded.history_order,
       author = excluded.author,
       subject = excluded.subject,
       blob_sha = excluded.blob_sha,
       status = excluded.status`,
  );
  const pkgIds = new Map<string, number>();
  const contributors = contributorWriter(db);
  let rows = 0;
  let historyOrder = 0;

  db.exec("BEGIN");
  clearContributorLinks(db, source, wanted.size ? names : undefined);
  for (const commit of commits) {
    const author = contributorFromIdentity(commit.author).displayName;
    for (const file of deletedFilesFirst(commit.files)) {
      const name = source.packageOf(file.path);
      if (!name) continue;
      if (wanted.size && !wanted.has(name)) continue;

      let pid = pkgIds.get(name);
      if (pid === undefined) {
        pid = upsertPackage(db, source.id, name);
        pkgIds.set(name, pid);
      }
      const r = insert.run(
        pid,
        commit.sha,
        file.blobSha,
        commit.committedAt,
        historyOrder,
        author,
        commit.subject,
        file.status,
      );
      contributors.link(pid, commit);
      rows += Number(r.changes);
    }
    historyOrder -= 1;
  }
  db.exec("COMMIT");
  return rows;
}

/**
 * L0 at full-catalog scale — one streaming whole-tree pass, bucketing every
 * touched package file by basename. Commits in batches to bound the journal.
 */
export async function buildCommitIndexAll(
  db: DatabaseSync,
  source: Source,
  onProgress?: (commits: number, rows: number, packages: number) => void,
  ref = "HEAD",
): Promise<{ commits: number; rows: number; packages: number }> {
  const insert = db.prepare(
    `INSERT INTO commit_index
       (package_id, commit_sha, blob_sha, committed_at, history_order, author, subject, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (package_id, commit_sha) DO UPDATE SET
       committed_at = excluded.committed_at,
       history_order = excluded.history_order,
       author = excluded.author,
       subject = excluded.subject,
       blob_sha = excluded.blob_sha,
       status = excluded.status`,
  );
  const pkgIds = new Map<string, number>();
  const contributors = contributorWriter(db);
  let commits = 0;
  let rows = 0;
  let historyOrder = 0;

  db.exec("BEGIN");
  clearContributorLinks(db, source);
  await streamLog(
    source.repoDir,
    (commit) => {
      commits += 1;
      const author = contributorFromIdentity(commit.author).displayName;
      for (const file of deletedFilesFirst(commit.files)) {
        const name = source.packageOf(file.path);
        if (!name) continue;
        let pid = pkgIds.get(name);
        if (pid === undefined) {
          pid = upsertPackage(db, source.id, name);
          pkgIds.set(name, pid);
        }
        rows += Number(
          insert.run(
            pid,
            commit.sha,
            file.blobSha,
            commit.committedAt,
            historyOrder,
            author,
            commit.subject,
            file.status,
          ).changes,
        );
        contributors.link(pid, commit);
      }
      historyOrder -= 1;
      if (commits % 25000 === 0) {
        db.exec("COMMIT");
        onProgress?.(commits, rows, pkgIds.size);
        db.exec("BEGIN");
      }
    },
    ref,
  );
  db.exec("COMMIT");
  return { commits, rows, packages: pkgIds.size };
}
