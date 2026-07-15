import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { type ContributionAggregate, contributionStatements } from "../src/crawl/incremental.ts";
import { openDb } from "../src/db/db.ts";
import { exportSlice } from "../src/db/export.ts";

describe("exportSlice contributors", () => {
  it("withholds incremental-only contributor data without a proven full seed", () => {
    const source = openDb(":memory:");
    source.exec(`
      INSERT INTO packages (id, source, name) VALUES (1, 'homebrew-formula', 'foo');
      INSERT INTO contributors
        (contributor_key, display_name, github_login, is_bot, last_seen_at)
      VALUES ('github:alice', 'Alice', 'alice', 0, 1700000100);
      INSERT INTO package_contributors
        (package_id, contributor_key, touch_count, version_count, first_at, last_at)
      VALUES (1, 'github:alice', 1, 0, 1700000000, 1700000100);
      INSERT INTO crawl_state (source, last_sha, last_crawled_at)
      VALUES ('homebrew-formula', '${"a".repeat(40)}', 1700000200);
    `);

    let sql = "";
    exportSlice(source, (chunk) => {
      sql += chunk;
    });
    source.close();

    const exported = new DatabaseSync(":memory:");
    exported.exec(sql);
    expect(exported.prepare("SELECT COUNT(*) AS count FROM contributor_seeds").get()).toEqual({
      count: 0,
    });
    expect(
      exported.prepare("SELECT COUNT(*) AS count FROM package_contribution_slices").get(),
    ).toEqual({ count: 0 });
    expect(exported.prepare("SELECT COUNT(*) AS count FROM contributors").get()).toEqual({
      count: 0,
    });
    exported.close();
  });

  it("emits a self-contained D1 contributor seed without author emails", () => {
    const source = openDb(":memory:");
    source.exec(`
      INSERT INTO packages (id, source, name) VALUES (1, 'homebrew-formula', 'foo');
      INSERT INTO contributors
        (contributor_key, display_name, github_login, is_bot, last_seen_at)
      VALUES ('github:alice', 'Alice', 'alice', 0, 1700000100);
      INSERT INTO package_contributors
        (package_id, contributor_key, touch_count, version_count, first_at, last_at)
      VALUES (1, 'github:alice', 3, 2, 1700000000, 1700000100);
      INSERT INTO crawl_state (source, last_sha, last_crawled_at)
      VALUES ('homebrew-formula', '${"a".repeat(40)}', 1700000200);
      INSERT INTO contributor_seeds (source, seeded_at_sha)
      VALUES ('homebrew-formula', '${"a".repeat(40)}');
    `);

    let sql = "";
    exportSlice(source, (chunk) => {
      sql += chunk;
    });
    source.close();

    expect(sql).not.toContain("@example.com");
    const exported = new DatabaseSync(":memory:");
    exported.exec(sql);
    expect(
      exported
        .prepare(
          `SELECT c.display_name, pcs.touch_count, pcs.version_count,
                  pcs.window_start_sha, pcs.window_end_sha
             FROM package_contribution_slices pcs
             JOIN contributors c ON c.contributor_key = pcs.contributor_key`,
        )
        .get(),
    ).toEqual({
      display_name: "Alice",
      touch_count: 3,
      version_count: 2,
      window_start_sha: "seed",
      window_end_sha: "a".repeat(40),
    });
    expect(exported.prepare("SELECT source, seeded_at_sha FROM contributor_seeds").get()).toEqual({
      source: "homebrew-formula",
      seeded_at_sha: "a".repeat(40),
    });

    const delta: ContributionAggregate = {
      contributor: {
        key: "github:alice",
        displayName: "Alice",
        githubLogin: "alice",
        isBot: false,
        role: "author",
      },
      touchCount: 2,
      versionCount: 1,
      firstAt: 1700000300,
      lastAt: 1700000400,
    };
    const retryable = contributionStatements("1", "a".repeat(40), "b".repeat(40), [delta]).join(
      "\n",
    );
    exported.exec(retryable);
    exported.exec(retryable);
    expect(
      exported
        .prepare(
          "SELECT SUM(touch_count) AS touches, SUM(version_count) AS versions FROM package_contribution_slices WHERE package_id = 1",
        )
        .get(),
    ).toEqual({ touches: 5, versions: 3 });

    delta.touchCount = 3;
    delta.versionCount = 2;
    delta.lastAt = 1700000500;
    exported.exec(contributionStatements("1", "a".repeat(40), "c".repeat(40), [delta]).join("\n"));
    expect(
      exported
        .prepare(
          "SELECT SUM(touch_count) AS touches, SUM(version_count) AS versions FROM package_contribution_slices WHERE package_id = 1",
        )
        .get(),
    ).toEqual({ touches: 6, versions: 4 });
    exported.close();
  });
});
