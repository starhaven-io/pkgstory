import { execFileSync } from "node:child_process";
import { diffFiles, logSince, type RawCommit, type RawFile, streamLog } from "../git.ts";
import { versionFromSubject } from "../parse/subject.ts";
import type { Source } from "../sources/index.ts";

export interface IntegratedCommit {
  commit: RawCommit;
  merged: RawCommit[];
}

function mainlineParent(source: Source, sha: string, parents: string[]): string | undefined {
  const reviewed = source.historyParents?.[sha];
  if (!reviewed) return parents[0];
  if (parents.length !== 2 || parents.some((parent, index) => parent !== reviewed[index])) {
    throw new Error(`reviewed history parents do not match ${sha}; refusing ancestry correction`);
  }
  return reviewed[1];
}

function mainlineCommits(source: Source, ref: string, cursor?: string): Set<string> {
  const mainline = new Set<string>();
  let tip: string | undefined = ref;
  while (tip) {
    const output = execFileSync(
      "git",
      ["-C", source.repoDir, "rev-list", "--first-parent", tip, ...(cursor ? [`^${cursor}`] : [])],
      { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
    );
    tip = undefined;
    for (const sha of output.trim().split("\n").filter(Boolean)) {
      mainline.add(sha);
      if (!source.historyParents?.[sha]) continue;
      const parents = execFileSync(
        "git",
        ["-C", source.repoDir, "show", "-s", "--format=%P", sha],
        {
          encoding: "utf8",
        },
      )
        .trim()
        .split(" ");
      tip = mainlineParent(source, sha, parents);
      break;
    }
  }
  return mainline;
}

// Parents precede children in the reversed topological walk. Only unintegrated
// side-branch commits need to retain their file lists, and each is consumed once.
function integrationFolder(
  source: Source,
  mainline: Set<string>,
  cursor?: string,
  paths: string[] = [],
) {
  const pending = new Map<string, { commit: RawCommit; order: number }>();
  let order = 0;
  let previous = cursor;
  return {
    push(commit: RawCommit): IntegratedCommit | null {
      if (!mainline.delete(commit.sha)) {
        pending.set(commit.sha, { commit, order: order++ });
        return null;
      }
      const parent = mainlineParent(source, commit.sha, commit.parents);
      if (parent !== previous) {
        throw new Error(
          "crawl cursor is not on the selected mainline history; rebuild and reseed the source",
        );
      }
      previous = commit.sha;
      const merged: { commit: RawCommit; order: number }[] = [];
      const todo = commit.parents.filter((candidate) => candidate !== parent);
      while (todo.length) {
        const sha = todo.pop();
        if (!sha) continue;
        const entry = pending.get(sha);
        if (!entry) continue;
        pending.delete(sha);
        merged.push(entry);
        todo.push(...entry.commit.parents);
      }
      merged.sort((a, b) => a.order - b.order);
      if (parent && parent !== commit.parents[0]) {
        commit = { ...commit, files: diffFiles(source.repoDir, parent, commit.sha, paths) };
      }
      return { commit, merged: merged.map((entry) => entry.commit) };
    },
    finish(): void {
      if (mainline.size || pending.size) throw new Error("incomplete Git integration history");
    },
  };
}

export function integratedLogSince(
  source: Source,
  cursor: string,
  head: string,
): IntegratedCommit[] {
  const folder = integrationFolder(source, mainlineCommits(source, head, cursor), cursor);
  const groups = logSince(source.repoDir, cursor, head).flatMap((commit) => {
    const group = folder.push(commit);
    return group ? [group] : [];
  });
  folder.finish();
  return groups;
}

export async function streamIntegratedLog(
  source: Source,
  onCommit: (group: IntegratedCommit) => void,
  ref: string,
  paths: string[] = [],
): Promise<void> {
  const folder = integrationFolder(source, mainlineCommits(source, ref), undefined, paths);
  await streamLog(
    source.repoDir,
    (commit) => {
      const group = folder.push(commit);
      if (group) onCommit(group);
    },
    ref,
    true,
    paths,
  );
  folder.finish();
}

export function integratedSubject(group: IntegratedCommit, file: RawFile): string {
  for (let index = group.merged.length - 1; index >= 0; index -= 1) {
    const commit = group.merged[index];
    if (
      commit?.files.some(
        (candidate) => candidate.path === file.path && candidate.blobSha === file.blobSha,
      )
    ) {
      return commit.subject;
    }
  }
  return group.commit.subject;
}

/** Resolve a version hint even when conflict resolution produced a new blob. */
export function integratedVersionSubject(
  group: IntegratedCommit,
  file: RawFile,
  source: Source,
): string {
  const name = source.packageOf(file.path);
  if (!name || group.merged.length === 0) return group.commit.subject;
  const commits = new Map(group.merged.map((commit) => [commit.sha, commit]));
  const suppliesBlob = (commit: RawCommit) =>
    commit.files.some((entry) => entry.path === file.path && entry.blobSha === file.blobSha);
  // An internal merge can repeat the supplied blob while its first parent lies
  // on a different branch. Prefer the original edit when it is available.
  let candidate =
    group.merged.findLast((commit) => commit.parents.length < 2 && suppliesBlob(commit)) ??
    group.merged.findLast(suppliesBlob) ??
    group.merged.findLast(
      (commit) =>
        commit.parents.length < 2 &&
        commit.files.some((entry) => source.packageOf(entry.path) === name && entry.status !== "D"),
    );
  while (candidate) {
    if (
      candidate.files.some((entry) => source.packageOf(entry.path) === name) &&
      versionFromSubject(name, candidate.subject)
    )
      return candidate.subject;
    candidate = commits.get(candidate.parents[0] ?? "");
  }
  return group.commit.subject;
}
