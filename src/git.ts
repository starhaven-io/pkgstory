import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface RawFile {
  status: string; // A, M, D, …
  parentBlobSha: string;
  blobSha: string; // post-image blob sha ("000…" when deleted)
  path: string;
}

export interface GitIdentity {
  name: string;
  email: string;
}

export interface RawCommit {
  sha: string;
  parents: string[];
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
const FORMAT = `${COMMIT}%H%x00%P%x00%ct%x00%aE%x00%aN%x00%(trailers:key=Co-authored-by,valueonly,separator=%x1d,unfold)%x00%s`;
const MAX_DATE_SECONDS = 8_640_000_000_000;

function parseIdentity(value: string): GitIdentity | null {
  const match = value.trim().match(/^(.*?)\s*<([^<>]+)>$/);
  if (!match) return null;
  return { name: match[1]?.trim() ?? "", email: match[2]?.trim() ?? "" };
}

function parseTimestamp(raw: string | undefined, sha: string): number {
  if (raw === undefined || !/^-?\d+$/.test(raw)) {
    throw new RangeError(
      `invalid commit timestamp for ${sha || "unknown commit"}: ${raw ?? "missing"}`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_DATE_SECONDS) {
    throw new RangeError(`commit timestamp is outside JavaScript's Date range for ${sha}: ${raw}`);
  }
  return value;
}

/** Incremental history is valid only when the stored cursor still precedes HEAD. */
export function assertAncestor(repoDir: string, cursor: string, head: string): void {
  try {
    execFileSync("git", ["-C", repoDir, "merge-base", "--is-ancestor", cursor, head], {
      stdio: "ignore",
    });
  } catch (cause) {
    throw new Error("crawl cursor is not an ancestor of HEAD; rebuild and reseed the source", {
      cause,
    });
  }
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

function parseRawFile(line: string): RawFile | null {
  if (!line.startsWith(":")) return null;
  // :<srcmode> <dstmode> <srcsha> <dstsha> <status>\t<path>
  const tab = line.indexOf("\t");
  if (tab === -1) return null;
  const meta = line.slice(1, tab).split(/\s+/);
  return {
    status: meta[4] ?? "",
    parentBlobSha: meta[2] ?? "",
    blobSha: meta[3] ?? "",
    path: line.slice(tab + 1),
  };
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
          parents: parts[1] ? parts[1].split(" ") : [],
          committedAt: parseTimestamp(parts[2], parts[0] ?? ""),
          author: { name: parts[4] ?? "", email: parts[3] ?? "" },
          coauthors: (parts[5] ?? "")
            .split(IDENTITY)
            .map(parseIdentity)
            .filter((identity): identity is GitIdentity => identity !== null),
          subject: parts.slice(6).join(FIELD),
          files: [],
        };
      } else if (cur) {
        const file = parseRawFile(line);
        if (file) cur.files.push(file);
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

/** Recompute a reviewed pull merge relative to its published upstream parent. */
export function diffFiles(
  repoDir: string,
  parent: string,
  commit: string,
  pathspecs: string[] = [],
): RawFile[] {
  const out = execFileSync(
    "git",
    [
      "-C",
      repoDir,
      "diff-tree",
      "--raw",
      "-r",
      "--no-commit-id",
      "--no-renames",
      "--no-abbrev",
      "--no-ext-diff",
      parent,
      commit,
      "--",
      ...pathspecs,
    ],
    { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
  );
  return out.split("\n").flatMap((line) => {
    const file = parseRawFile(line);
    return file ? [file] : [];
  });
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
    if (type === "missing") throw new Error(`git object is missing: ${sha}`);
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

export function headFile(repoDir: string, path: string, ref = "HEAD"): string | null {
  const entry = execFileSync(
    "git",
    ["-C", repoDir, "ls-tree", "-z", "--name-only", ref, "--", `:(literal)${path}`],
    { encoding: "utf8", maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (entry.length === 0) return null;

  return execFileSync("git", ["-C", repoDir, "show", `${ref}:${path}`], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
  });
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
  ref = "HEAD",
): Set<string> {
  const out = execFileSync(
    "git",
    ["-C", repoDir, "ls-tree", "-r", "--name-only", ref, "--", `${dir}/`],
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
export function logSince(repoDir: string, sinceSha: string, head = "HEAD"): RawCommit[] {
  const out = execFileSync(
    "git",
    [
      "-C",
      repoDir,
      "log",
      "--topo-order",
      "--raw",
      "--diff-merges=first-parent",
      "--no-renames",
      "--no-abbrev",
      "--reverse",
      "--date=unix",
      `--format=${FORMAT}`,
      `${sinceSha}..${head}`,
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
  ref = "HEAD",
  oldestFirst = false,
  pathspecs: string[] = [],
): Promise<void> {
  const child = spawn(
    "git",
    [
      "-C",
      repoDir,
      "log",
      "--topo-order",
      "--raw",
      "--diff-merges=first-parent",
      ...(oldestFirst ? ["--reverse"] : []),
      ...(pathspecs.length ? ["--full-history", "--sparse"] : []),
      "--no-renames",
      "--no-abbrev",
      "--date=unix",
      `--format=${FORMAT}`,
      ref,
      ...(pathspecs.length ? ["--", ...pathspecs] : []),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  // Drain stderr eagerly — the cap bounds what we keep, not what we read, so the
  // pipe can never fill and block git. Reported either way: attached to the
  // thrown error on failure, warned about on success.
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < 8192) stderr += chunk.slice(0, 8192 - stderr.length);
  });

  const exit = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const detail = stderr.trim();
      if (code === 0) {
        if (detail) console.warn(`git log warning: ${detail}`);
        resolve();
        return;
      }
      const cause = signal ? `git log exited with signal ${signal}` : `git log exited ${code}`;
      reject(new Error(detail ? `${cause}: ${detail}` : cause));
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
