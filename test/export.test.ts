import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { type ContributionAggregate, contributionStatements } from "../src/crawl/incremental.ts";
import { openDb } from "../src/db/db.ts";
import { exportSlice } from "../src/db/export.ts";

describe("exportSlice round-trip", () => {
  it("recreates the full site slice in a fresh database, seed marker last", () => {
    const source = openDb(":memory:");
    source.exec(`
      INSERT INTO packages
        (id, source, name, latest_version, latest_revision, latest_at, latest_bottled,
         latest_bottle_tags, event_count, bottle_event_count, bottle_interval_count)
      VALUES (1, 'homebrew-formula', 'foo', '1.1', 0, 1700000100, 1,
              '["sonoma"]', 2, 1, 1),
             (2, 'homebrew-cask', 'bar-app', '2.0', 1, 1700000200, NULL,
              NULL, 1, 0, 0);
      INSERT INTO version_events (package_id, version, revision, introduced_at, commit_sha, subject)
      VALUES (1, '1.0', 0, 1700000000, '${"a".repeat(40)}', 'foo 1.0'),
             (1, '1.1', 0, 1700000100, '${"b".repeat(40)}', 'foo 1.1 with ''quotes'''),
             (2, '2.0', 1, 1700000200, '${"c".repeat(40)}', 'bar-app 2.0');
      INSERT INTO bottle_events
        (package_id, bottled, version, revision, changed_at, commit_sha, subject)
      VALUES (1, 1, '1.1', 0, 1700000150, '${"d".repeat(40)}', 'foo: bottle 1.1');
      INSERT INTO bottle_intervals
        (package_id, tag, started_at, started_commit, started_subject,
         ended_at, ended_commit, ended_subject)
      VALUES (1, 'sonoma', 1700000150, '${"d".repeat(40)}', 'foo: bottle Sonoma',
              1700000250, '${"e".repeat(40)}', 'foo: remove Sonoma');
      INSERT INTO contributors (contributor_key, display_name, github_login, is_bot, last_seen_at)
      VALUES ('github:alice', 'Alice', 'alice', 0, 1700000100);
      INSERT INTO package_contributors (package_id, contributor_key, touch_count, version_count, first_at, last_at)
      VALUES (1, 'github:alice', 2, 2, 1700000000, 1700000100);
      INSERT INTO crawl_state (source, last_sha, last_crawled_at)
      VALUES ('homebrew-formula', '${"b".repeat(40)}', 1700000300);
      INSERT INTO contributor_seeds (source, seeded_at_sha) VALUES ('homebrew-formula', '${"b".repeat(40)}');
    `);

    let sql = "";
    exportSlice(source, (chunk) => {
      sql += chunk;
    });
    source.close();

    // The seed marker must land after every data table: a partial reseed that died
    // mid-file must not enable incremental contributor writes on a half-seed.
    const inserts = sql
      .split("\n")
      .filter((line) => line.startsWith("INSERT INTO "))
      .map((line) => line.split(" ")[2]);
    expect(inserts.at(-1)).toBe("contributor_seeds");
    expect(inserts.indexOf("contributor_seeds")).toBe(inserts.length - 1);

    const exported = new DatabaseSync(":memory:");
    exported.exec(sql);
    const count = (table: string) =>
      (exported.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count("packages")).toBe(2);
    expect(count("version_events")).toBe(3);
    expect(count("bottle_events")).toBe(1);
    expect(count("bottle_intervals")).toBe(1);
    expect(count("contributors")).toBe(1);
    expect(count("package_contribution_slices")).toBe(1);
    expect(count("crawl_state")).toBe(1);
    expect(count("contributor_seeds")).toBe(1);

    expect(
      exported
        .prepare(
          "SELECT version, revision, subject FROM version_events WHERE package_id = 1 ORDER BY introduced_at",
        )
        .all(),
    ).toEqual([
      { version: "1.0", revision: 0, subject: "foo 1.0" },
      { version: "1.1", revision: 0, subject: "foo 1.1 with 'quotes'" },
    ]);
    expect(
      exported.prepare("SELECT latest_version, event_count FROM packages WHERE id = 2").get(),
    ).toEqual({ latest_version: "2.0", event_count: 1 });
    expect(
      exported
        .prepare(
          "SELECT bottled, version, changed_at, subject FROM bottle_events WHERE package_id = 1",
        )
        .get(),
    ).toEqual({
      bottled: 1,
      version: "1.1",
      changed_at: 1700000150,
      subject: "foo: bottle 1.1",
    });
    expect(
      exported
        .prepare(
          "SELECT tag, started_at, started_commit, ended_at, ended_commit FROM bottle_intervals WHERE package_id = 1",
        )
        .get(),
    ).toEqual({
      tag: "sonoma",
      started_at: 1700000150,
      started_commit: "d".repeat(40),
      ended_at: 1700000250,
      ended_commit: "e".repeat(40),
    });
    exported.close();
  });
});

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
