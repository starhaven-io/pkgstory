import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { batchCat, parseBatchCat, parseLog, type RawCommit, streamLog } from "../src/git.ts";

// Raw `git log --raw --format=<COMMIT>%H<FIELD>%at<FIELD>%an<FIELD>%s` output uses
// \x1e/\x1f separators (never present in a subject) and one ":<modes> <shas> <status>\t<path>"
// line per touched file.
const C = "\x1ecommit\x1e";
const F = "\x1f";

function commitLine(sha: string, at: number, author: string, subject: string): string {
  return `${C}${sha}${F}${at}${F}${author}${F}${subject}`;
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const BLOB_1 = "1".repeat(40);
const BLOB_2 = "2".repeat(40);
const ZEROS = "0".repeat(40);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "pkgstory-test",
  GIT_AUTHOR_EMAIL: "test@pkgstory.invalid",
  GIT_COMMITTER_NAME: "pkgstory-test",
  GIT_COMMITTER_EMAIL: "test@pkgstory.invalid",
};

const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

class GitRepo {
  readonly dir: string;
  private tick = 0;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "pkgstory-git-"));
    cleanups.push(this.dir);
    this.git("init", "-q", "-b", "main");
  }

  git(...args: string[]): string {
    return execFileSync("git", ["-C", this.dir, ...args], {
      encoding: "utf8",
      env: {
        ...GIT_ENV,
        GIT_AUTHOR_DATE: `${1750000000 + this.tick * 1000} +0000`,
        GIT_COMMITTER_DATE: `${1750000000 + this.tick * 1000} +0000`,
      },
    }).trim();
  }

  write(path: string, content: string): void {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  commit(message: string): string {
    this.tick += 1;
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message);
    return this.git("rev-parse", "HEAD");
  }
}

describe("parseLog", () => {
  it("parses commits with their touched files", () => {
    const out = [
      commitLine(SHA_A, 1700000000, "BrewTestBot", "git 2.54.0"),
      `:100644 100644 ${BLOB_1} ${BLOB_2} M\tFormula/g/git.rb`,
      commitLine(SHA_B, 1690000000, "Someone Else", "git: fix build"),
      `:100644 100644 ${BLOB_2} ${BLOB_1} M\tFormula/g/git.rb`,
      "",
    ].join("\n");

    const commits = parseLog(out);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      sha: SHA_A,
      committedAt: 1700000000,
      author: "BrewTestBot",
      subject: "git 2.54.0",
      files: [{ status: "M", blobSha: BLOB_2, path: "Formula/g/git.rb" }],
    });
    expect(commits[1]?.files[0]?.blobSha).toBe(BLOB_1);
  });

  it("keeps both sides of a relocation (delete + add in one commit)", () => {
    const out = [
      commitLine(SHA_A, 1700000000, "Bot", "git: move to Formula/g/"),
      `:000000 100644 ${ZEROS} ${BLOB_1} A\tFormula/g/git.rb`,
      `:100644 000000 ${BLOB_1} ${ZEROS} D\tFormula/git.rb`,
    ].join("\n");

    const [commit] = parseLog(out);
    expect(commit?.files).toEqual([
      { status: "A", blobSha: BLOB_1, path: "Formula/g/git.rb" },
      { status: "D", blobSha: ZEROS, path: "Formula/git.rb" },
    ]);
  });

  it("handles a deletion's all-zero post-image blob", () => {
    const out = [
      commitLine(SHA_A, 1700000000, "Bot", "terraform: delete"),
      `:100644 000000 ${BLOB_1} ${ZEROS} D\tFormula/t/terraform.rb`,
    ].join("\n");

    expect(parseLog(out)[0]?.files[0]).toEqual({
      status: "D",
      blobSha: ZEROS,
      path: "Formula/t/terraform.rb",
    });
  });

  it("returns no commits for empty output", () => {
    expect(parseLog("")).toEqual([]);
    expect(parseLog("\n")).toEqual([]);
  });
});

describe("batchCat", () => {
  it("returns valid blobs and skips missing objects", () => {
    const repo = new GitRepo();
    repo.write(
      "Formula/f/foo.rb",
      'class Foo < Formula\n  url "https://example.com/foo-1.0.tar.gz"\nend\n',
    );
    repo.commit("foo 1.0");
    const blobSha = repo.git("rev-parse", "HEAD:Formula/f/foo.rb");
    const missingSha = "f".repeat(40);

    const blobs = batchCat(repo.dir, [blobSha, missingSha]);
    expect(blobs.get(blobSha)).toContain("foo-1.0");
    expect(blobs.has(missingSha)).toBe(false);
  });

  it("rejects malformed cat-file sizes instead of silently truncating", () => {
    const sha = "a".repeat(40);
    expect(() => parseBatchCat(Buffer.from(`${sha} blob nope\ncontent\n`))).toThrow(/invalid size/);
    expect(() => parseBatchCat(Buffer.from(`${sha} blob 20\nshort\n`))).toThrow(/exceeds output/);
    expect(() => parseBatchCat(Buffer.from(`${sha} blob 5\nshort!`))).toThrow(
      /missing trailing newline/,
    );
    expect(() => parseBatchCat(Buffer.from(`${sha} blob 5`))).toThrow(/unterminated header/);
  });
});

describe("streamLog", () => {
  it("streams raw commits from git log", async () => {
    const repo = new GitRepo();
    repo.write(
      "Formula/f/foo.rb",
      'class Foo < Formula\n  url "https://example.com/foo-1.0.tar.gz"\nend\n',
    );
    repo.commit("foo 1.0");
    repo.write(
      "Formula/f/foo.rb",
      'class Foo < Formula\n  url "https://example.com/foo-1.1.tar.gz"\nend\n',
    );
    repo.commit("foo 1.1");

    const commits: RawCommit[] = [];
    await streamLog(repo.dir, (commit) => commits.push(commit));

    expect(commits.map((c) => c.subject)).toEqual(["foo 1.1", "foo 1.0"]);
    expect(commits[0]?.files[0]?.path).toBe("Formula/f/foo.rb");
  });

  it("rejects a nonzero git log exit", async () => {
    const commits: RawCommit[] = [];
    await expect(
      streamLog(join(tmpdir(), "pkgstory-missing-repo"), (c) => commits.push(c)),
    ).rejects.toThrow(/git log exited/);
    expect(commits).toEqual([]);
  });

  it("rejects a spawn failure", async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(streamLog(".", () => {})).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });
});
