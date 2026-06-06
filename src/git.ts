import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface RawFile {
  status: string; // A, M, D, …
  blobSha: string; // post-image blob sha ("000…" when deleted)
  path: string;
}

export interface RawCommit {
  sha: string;
  committedAt: number; // unix seconds
  author: string;
  subject: string;
  files: RawFile[];
}

// Record separators that never appear in a commit subject.
const COMMIT = "\x1ecommit\x1e";
const FIELD = "\x1f";

/** Resolve a Homebrew tap to its local clone, e.g. `brew --repository homebrew/core`. */
export function repoRoot(tap: string): string {
  return execFileSync("brew", ["--repository", tap], { encoding: "utf8" }).trim();
}

export function repoExists(dir: string): boolean {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--git-dir"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * One `git log --raw` pass. With pathspecs the diff is scoped to those files (fast
 * path, used for a curated package set). Pass [] to walk the whole tree — the
 * production L0, where every package is bucketed by basename downstream, which is
 * what makes the index immune to Homebrew's historical file relocations.
 */
export function logRaw(repoDir: string, pathspecs: string[]): RawCommit[] {
  const args = [
    "-C",
    repoDir,
    "log",
    "--raw",
    "--no-renames",
    "--no-abbrev", // full 40-char blob shas — `--raw` abbreviates by default
    "--date=unix",
    `--format=${COMMIT}%H${FIELD}%at${FIELD}%an${FIELD}%s`,
  ];
  if (pathspecs.length) args.push("--", ...pathspecs);
  const out = execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 512,
  });
  return parseLog(out);
}

export function parseLog(out: string): RawCommit[] {
  const commits: RawCommit[] = [];
  let cur: RawCommit | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith(COMMIT)) {
      if (cur) commits.push(cur);
      const parts = line.slice(COMMIT.length).split(FIELD);
      cur = {
        sha: parts[0] ?? "",
        committedAt: Number(parts[1] ?? 0),
        author: parts[2] ?? "",
        subject: parts[3] ?? "",
        files: [],
      };
    } else if (line.startsWith(":") && cur) {
      // :<srcmode> <dstmode> <srcsha> <dstsha> <status>\t<path>
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      const meta = line.slice(1, tab).split(/\s+/);
      cur.files.push({
        status: meta[4] ?? "",
        blobSha: meta[3] ?? "",
        path: line.slice(tab + 1),
      });
    }
  }
  if (cur) commits.push(cur);
  return commits;
}

/**
 * Read many blobs in a single `git cat-file --batch` process and return a
 * sha→contents map. One git invocation for the whole set, instead of one spawn
 * per blob — the difference between seconds and minutes on a real crawl.
 */
export function batchCat(repoDir: string, shas: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const unique = [...new Set(shas)];
  if (unique.length === 0) return result;

  const out = execFileSync("git", ["-C", repoDir, "cat-file", "--batch"], {
    input: `${unique.join("\n")}\n`,
    maxBuffer: 1024 * 1024 * 1024,
  }); // Buffer (no encoding) so we can slice content by exact byte length

  let i = 0;
  while (i < out.length) {
    const nl = out.indexOf(0x0a, i);
    if (nl === -1) break;
    const [sha, type, size] = out.toString("utf8", i, nl).split(" ");
    i = nl + 1;
    if (!sha || type === "missing" || size === undefined) continue;
    const len = Number(size);
    result.set(sha, out.toString("utf8", i, i + len));
    i += len + 1; // skip the blob bytes and the trailing newline
  }
  return result;
}

/** Current HEAD sha — the cursor we store after an incremental crawl. */
export function headSha(repoDir: string): string {
  return execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/**
 * Package basenames present in `dir` at HEAD. The authoritative "still exists" signal
 * for removal detection: a package absent from this set has been deleted from the tap.
 * Read straight from the HEAD tree, so it's immune to the file relocations that make a
 * commit-status heuristic unreliable (a relocation is a delete + add in one commit).
 */
export function presentPackages(
  repoDir: string,
  dir: string,
  packageOf: (path: string) => string | null,
): Set<string> {
  const out = execFileSync(
    "git",
    ["-C", repoDir, "ls-tree", "-r", "--name-only", "HEAD", "--", `${dir}/`],
    { encoding: "utf8", maxBuffer: 1024 * 1024 * 256 },
  );
  const set = new Set<string>();
  for (const path of out.split("\n")) {
    const name = packageOf(path);
    if (name) set.add(name);
  }
  return set;
}

/**
 * The delta since a cursor: `git log <sinceSha>..HEAD --raw`. Buffered (not
 * streamed) because an incremental window is a handful of commits, not the whole
 * history. Oldest-first so callers can fold versions chronologically.
 */
export function logSince(repoDir: string, sinceSha: string): RawCommit[] {
  const out = execFileSync(
    "git",
    [
      "-C",
      repoDir,
      "log",
      "--raw",
      "--no-renames",
      "--no-abbrev",
      "--reverse",
      "--date=unix",
      `--format=${COMMIT}%H${FIELD}%at${FIELD}%an${FIELD}%s`,
      `${sinceSha}..HEAD`,
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 * 256 },
  );
  return parseLog(out);
}

/**
 * Stream the whole-repo `git log --raw` pass, invoking `onCommit` for each commit
 * as it is parsed. Used for full-catalog indexing where buffering the entire log
 * (hundreds of MB) is not viable — memory stays bounded to one commit at a time.
 */
export async function streamLog(
  repoDir: string,
  onCommit: (commit: RawCommit) => void,
): Promise<void> {
  const child = spawn(
    "git",
    [
      "-C",
      repoDir,
      "log",
      "--raw",
      "--no-renames",
      "--no-abbrev",
      "--date=unix",
      `--format=${COMMIT}%H${FIELD}%at${FIELD}%an${FIELD}%s`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );

  if (!child.stdout) throw new Error("git log produced no stdout");
  const rl = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  let cur: RawCommit | null = null;
  for await (const line of rl) {
    if (line.startsWith(COMMIT)) {
      if (cur) onCommit(cur);
      const parts = line.slice(COMMIT.length).split(FIELD);
      cur = {
        sha: parts[0] ?? "",
        committedAt: Number(parts[1] ?? 0),
        author: parts[2] ?? "",
        subject: parts[3] ?? "",
        files: [],
      };
    } else if (line.startsWith(":") && cur) {
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      const meta = line.slice(1, tab).split(/\s+/);
      cur.files.push({ status: meta[4] ?? "", blobSha: meta[3] ?? "", path: line.slice(tab + 1) });
    }
  }
  if (cur) onCommit(cur);

  await new Promise<void>((resolve, reject) => {
    child.on("close", (code) => (code ? reject(new Error(`git log exited ${code}`)) : resolve()));
  });
}
