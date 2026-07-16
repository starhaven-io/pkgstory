import { describe, expect, it } from "vitest";
import { commitAttributions, contributorFromIdentity } from "../src/contributors.ts";
import type { RawCommit } from "../src/git.ts";

describe("contributor identities", () => {
  it("derives a stable GitHub identity without retaining the email", () => {
    expect(
      contributorFromIdentity({
        name: "Carlo Cabrera",
        email: "30379873+carlocab@users.noreply.github.com",
      }),
    ).toEqual({
      key: "github:carlocab",
      displayName: "Carlo Cabrera",
      githubLogin: "carlocab",
      isBot: false,
    });
  });

  it("collapses one bot's many addresses into a single identity", () => {
    // Every address BrewTestBot has authored formula changes under since 2014.
    const keys = [
      "1589480+BrewTestBot@users.noreply.github.com",
      "BrewTestBot@users.noreply.github.com",
      "ops@brew.sh",
      "brew-test-bot@googlegroups.com",
      "homebrew-test-bot@lists.sfconservancy.org",
    ].map((email) => contributorFromIdentity({ name: "BrewTestBot", email }));

    expect(new Set(keys.map((c) => c.key))).toEqual(new Set(["bot:brewtestbot"]));
    expect(keys.every((c) => c.isBot)).toBe(true);
    // Only the noreply addresses carry a login; the crawler's COALESCE upsert is
    // what keeps it once seen.
    expect(keys.map((c) => c.githubLogin)).toEqual([
      "brewtestbot",
      "brewtestbot",
      null,
      null,
      null,
    ]);
  });

  it("keys distinct bots apart and never merges a bot with a person", () => {
    const distinct = [
      contributorFromIdentity({ name: "BrewTestBot", email: "ops@brew.sh" }),
      contributorFromIdentity({
        name: "dependabot[bot]",
        email: "49699333+dependabot[bot]@users.noreply.github.com",
      }),
      contributorFromIdentity({
        name: "Pulumi Bot",
        email: "30351955+pulumi-bot@users.noreply.github.com",
      }),
      // A person whose name merely ends in bot-ish letters stays email-keyed.
      contributorFromIdentity({ name: "botantony", email: "antonsm21@gmail.com" }),
    ];
    expect(new Set(distinct.map((c) => c.key)).size).toBe(4);
    expect(distinct.map((c) => c.isBot)).toEqual([true, true, true, false]);
    expect(distinct[3]?.key).toMatch(/^email:/);
  });

  it("hashes non-GitHub email identities case-insensitively", () => {
    const first = contributorFromIdentity({ name: "Someone", email: "Person@Example.com" });
    const second = contributorFromIdentity({ name: "Renamed", email: "person@example.com" });
    expect(first.key).toBe(second.key);
    expect(first.key).toMatch(/^email:[0-9a-f]{64}$/);
  });

  it("does not turn an invalid noreply local part into a GitHub profile link", () => {
    const contributor = contributorFromIdentity({
      name: "Untrusted",
      email: "not/a/login@users.noreply.github.com",
    });
    expect(contributor.githubLogin).toBeNull();
    expect(contributor.key).toMatch(/^email:/);
  });

  it("classifies explicit bot identities without treating bot-prefixed humans as bots", () => {
    expect(
      contributorFromIdentity({
        name: "BrewTestBot",
        email: "1589480+BrewTestBot@users.noreply.github.com",
      }).isBot,
    ).toBe(true);
    expect(contributorFromIdentity({ name: "botantony", email: "human@example.com" }).isBot).toBe(
      false,
    );
  });

  it("keeps the primary role when a co-author repeats the author", () => {
    const commit: RawCommit = {
      sha: "a".repeat(40),
      committedAt: 1700000000,
      author: { name: "Alice", email: "alice@example.com" },
      coauthors: [
        { name: "Alice Again", email: "alice@example.com" },
        { name: "Bob", email: "1+bob@users.noreply.github.com" },
      ],
      subject: "pkg 1.0",
      files: [],
    };

    expect(
      commitAttributions(commit).map(({ displayName, role }) => ({ displayName, role })),
    ).toEqual([
      { displayName: "Alice", role: "author" },
      { displayName: "Bob", role: "coauthor" },
    ]);
  });
});
