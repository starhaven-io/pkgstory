import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface RawFile {
  status: string; // A, M, D, …
  blobSha: string; // post-image blob sha ("000…" when deleted)
  path: string;
}

export interface GitIdentity {
  name: string;
  email: string;
}

export interface RawCommit {
  sha: string;
  committedAt: number; // unix seconds
  author: GitIdentity;
  coauthors: GitIdentity[];
  subject: string;
  files: RawFile[];
}

// NUL cannot occur in normal Git identity or commit-message fields. Keep the
// subject last and rejoin defensively so malformed input cannot forge trailers.
// %aN/%aE honour a tap's own .mailmap when it has one; pkgstory ships no alias
// list of its own, so identities are exactly what the tap's history reports.
const COMMIT = "\x1ecommit\x1e";
const FIELD = "\0";
const IDENTITY = "\x1d";
const FORMAT = `${COMMIT}%H%x00%at%x00%aE%x00%aN%x00%(trailers:key=Co-authored-by,valueonly,separator=%x1d,unfold)%x00%s`;

function parseIdentity(value: string): GitIdentity | null {
  const match = value.trim().match(/^(.*?)\s*<([^<>]+)>$/);
  if (!match) return null;
  return { name: match[1]?.trim() ?? "", email: match[2]?.trim() ?? "" };
}

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
    `--format=${FORMAT}`,
  ];
  if (pathspecs.length) args.push("--", ...pathspecs);
  const out = execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 512,
  });
  return parseLog(out);
}

/**
 * Line-by-line folder for `git log --raw` output, shared by the buffered and
 * streaming paths so the two can't drift. Feed lines, then `end()` to flush the
 * final commit.
 */
function logFolder(onCommit: (commit: RawCommit) => void): {
  line(line: string): void;
  end(): void;
} {
  let cur: RawCommit | null = null;
  return {
    line(line: string): void {
      if (line.startsWith(COMMIT)) {
        if (cur) onCommit(cur);
        const parts = line.slice(COMMIT.length).split(FIELD);
        cur = {
          sha: parts[0] ?? "",
          committedAt: Number(parts[1] ?? 0),
          author: { name: parts[3] ?? "", email: parts[2] ?? "" },
          coauthors: (parts[4] ?? "")
            .split(IDENTITY)
            .map(parseIdentity)
            .filter((identity): identity is GitIdentity => identity !== null),
          subject: parts.slice(5).join(FIELD),
          files: [],
        };
      } else if (line.startsWith(":") && cur) {
        // :<srcmode> <dstmode> <srcsha> <dstsha> <status>\t<path>
        const tab = line.indexOf("\t");
        if (tab === -1) return;
        const meta = line.slice(1, tab).split(/\s+/);
        cur.files.push({
          status: meta[4] ?? "",
          blobSha: meta[3] ?? "",
          path: line.slice(tab + 1),
        });
      }
    },
    end(): void {
      if (cur) onCommit(cur);
      cur = null;
    },
  };
}

export function parseLog(out: string): RawCommit[] {
  const commits: RawCommit[] = [];
  const folder = logFolder((c) => commits.push(c));
  for (const line of out.split("\n")) folder.line(line);
  folder.end();
  return commits;
}

/**
 * Read many blobs in a single `git cat-file --batch` process and return a
 * sha→contents map. One git invocation for the whole set, instead of one spawn
 * per blob — the difference between seconds and minutes on a real crawl.
 */
export function batchCat(repoDir: string, shas: string[]): Map<string, string> {
  const unique = [...new Set(shas)];
  if (unique.length === 0) return new Map();

  const out = execFileSync("git", ["-C", repoDir, "cat-file", "--batch"], {
    input: `${unique.join("\n")}\n`,
    maxBuffer: 1024 * 1024 * 1024,
  }); // Buffer (no encoding) so we can slice content by exact byte length

  return parseBatchCat(out);
}

export function parseBatchCat(out: Buffer): Map<string, string> {
  const result = new Map<string, string>();
  let i = 0;
  while (i < out.length) {
    const nl = out.indexOf(0x0a, i);
    if (nl === -1) throw new Error("malformed git cat-file output: unterminated header");
    const header = out.toString("utf8", i, nl);
    const [sha, type, size] = header.split(" ");
    i = nl + 1;
    if (!sha) throw new Error(`malformed git cat-file header: ${header}`);
    if (type === "missing") continue;
    if (!type || size === undefined) throw new Error(`malformed git cat-file header: ${header}`);
    const len = Number(size);
    if (!Number.isInteger(len) || len < 0) {
      throw new Error(`malformed git cat-file header for ${sha}: invalid size ${size}`);
    }
    if (i + len >= out.length) {
      throw new Error(`malformed git cat-file output for ${sha}: declared size exceeds output`);
    }
    result.set(sha, out.toString("utf8", i, i + len));
    i += len;
    if (out[i] !== 0x0a) {
      throw new Error(`malformed git cat-file output for ${sha}: missing trailing newline`);
    }
    i += 1;
  }
  return result;
}

/** Current HEAD sha — the cursor we store after an incremental crawl. */
export function headSha(repoDir: string): string {
  return execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

export function headFile(repoDir: string, path: string): string | null {
  try {
    return execFileSync("git", ["-C", repoDir, "show", `HEAD:${path}`], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
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
      `--format=${FORMAT}`,
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
      `--format=${FORMAT}`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );

  const exit = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(signal ? `git log exited with signal ${signal}` : `git log exited ${code}`),
        );
    });
  });

  if (!child.stdout) {
    child.kill();
    await exit.catch(() => undefined);
    throw new Error("git log produced no stdout");
  }
  const rl = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  const folder = logFolder(onCommit);

  const output = (async () => {
    for await (const line of rl) folder.line(line);
  })();

  try {
    await Promise.all([output, exit]);
  } catch (e) {
    rl.close();
    child.kill();
    await output.catch(() => undefined);
    await exit.catch(() => undefined);
    throw e;
  }
  folder.end();
}
