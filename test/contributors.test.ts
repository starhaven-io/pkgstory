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
