import { describe, expect, it } from "vitest";
import { parseLog } from "../src/git.ts";

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
