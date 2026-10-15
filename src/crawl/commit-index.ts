import type { DatabaseSync } from "node:sqlite";
import { contributorFromIdentity } from "../contributors.ts";
import { upsertPackage } from "../db/db.ts";
import type { RawFile } from "../git.ts";
import type { Source } from "../sources/index.ts";
import { clearContributorLinks, contributorWriter } from "./contributors.ts";
import {
  type IntegratedCommit,
  integratedSubject,
  integratedVersionSubject,
  streamIntegratedLog,
} from "./history.ts";

// A relocation deletes and adds the same package in one commit. The live row
// must win the (package_id, commit_sha) upsert regardless of path sort order.
function deletedFilesFirst(files: RawFile[]): RawFile[] {
  return files.toSorted((a, b) => Number(b.status === "D") - Number(a.status === "D"));
}

function indexWriter(db: DatabaseSync, source: Source, names?: string[]) {
  const wanted = names ? new Set(names) : null;
  const insert = db.prepare(
    `INSERT INTO commit_index
       (package_id, commit_sha, blob_sha, parent_blob_sha, is_mainline, is_merge, integrated_sha, version_subject,
        committed_at, history_order, author, subject, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (package_id, commit_sha) DO UPDATE SET
       committed_at = excluded.committed_at, history_order = excluded.history_order,
       author = excluded.author, subject = excluded.subject, blob_sha = excluded.blob_sha,
       parent_blob_sha = excluded.parent_blob_sha, is_mainline = excluded.is_mainline,
       integrated_sha = excluded.integrated_sha, is_merge = excluded.is_merge,
       version_subject = excluded.version_subject, status = excluded.status`,
  );
  const pkgIds = new Map<string, number>(
    (
      db.prepare("SELECT id, name FROM packages WHERE source = ?").all(source.id) as {
        id: number;
        name: string;
      }[]
    ).map((row) => [row.name, row.id]),
  );
  const contributors = contributorWriter(db);
  let commits = 0;
  let rows = 0;
  let historyOrder = 0;

  return {
    write(group: IntegratedCommit): void {
      // A file created and removed entirely on a branch was never a tap package.
      for (const file of group.commit.files) {
        const name = source.packageOf(file.path);
        if (name && (!wanted || wanted.has(name)) && !pkgIds.has(name)) {
          pkgIds.set(name, upsertPackage(db, source.id, name));
        }
      }
      for (const commit of [...group.merged, group.commit]) {
        commits += 1;
        const mainline = commit === group.commit;
        if (!mainline && commit.parents.length > 1) continue;
        const author = contributorFromIdentity(commit.author).displayName;
        for (const file of deletedFilesFirst(commit.files)) {
          const name = source.packageOf(file.path);
          if (!name || (wanted && !wanted.has(name))) continue;
          const pid = pkgIds.get(name);
          if (pid === undefined) continue;
          rows += Number(
            insert.run(
              pid,
              commit.sha,
              file.blobSha,
              file.parentBlobSha,
              mainline ? 1 : 0,
              commit.parents.length > 1 ? 1 : 0,
              group.commit.sha,
              mainline ? integratedVersionSubject(group, file, source) : commit.subject,
              commit.committedAt,
              historyOrder,
              author,
              mainline ? integratedSubject(group, file) : commit.subject,
              file.status,
            ).changes,
          );
          if (commit.parents.length < 2) contributors.link(pid, commit);
        }
        historyOrder += 1;
      }
    },
    result: () => ({ commits, rows, packages: pkgIds.size }),
  };
}

/** L0 keeps branch authorship, while marking only integrated mainline states. */
export async function buildCommitIndex(
  db: DatabaseSync,
  source: Source,
  names: string[],
  ref = "HEAD",
): Promise<number> {
  const writer = indexWriter(db, source, names.length ? names : undefined);
  db.exec("BEGIN");
  try {
    clearContributorLinks(db, source, names.length ? names : undefined);
    await streamIntegratedLog(
      source,
      (group) => writer.write(group),
      ref,
      names.flatMap((name) => source.pathsFor(name)),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return writer.result().rows;
}

/** Full-catalog history streams; only outstanding side branches retain raw diffs. */
export async function buildCommitIndexAll(
  db: DatabaseSync,
  source: Source,
  onProgress?: (commits: number, rows: number, packages: number) => void,
  ref = "HEAD",
): Promise<{ commits: number; rows: number; packages: number }> {
  const writer = indexWriter(db, source);
  let checkpoint = 0;
  db.exec("BEGIN");
  try {
    clearContributorLinks(db, source);
    await streamIntegratedLog(
      source,
      (group) => {
        writer.write(group);
        const { commits, rows, packages } = writer.result();
        if (commits - checkpoint >= 25000) {
          db.exec("COMMIT");
          onProgress?.(commits, rows, packages);
          db.exec("BEGIN");
          checkpoint = commits;
        }
      },
      ref,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return writer.result();
}
