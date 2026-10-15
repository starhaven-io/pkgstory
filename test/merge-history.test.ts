import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildCommitIndex, buildCommitIndexAll } from "../src/crawl/commit-index.ts";
import { buildPackageContributors } from "../src/crawl/contributors.ts";
import { buildEvents } from "../src/crawl/events.ts";
import { computeDelta, crawlSince, crawlSinceD1 } from "../src/crawl/incremental.ts";
import { reconcileRemovals } from "../src/crawl/removals.ts";
import { buildSnapshots } from "../src/crawl/snapshot.ts";
import { d1Apply, d1Select } from "../src/db/d1remote.ts";
import { finalizeLatest, openDb, setCrawlState } from "../src/db/db.ts";
import { exportSlice } from "../src/db/export.ts";
import { headSha } from "../src/git.ts";
import { cleanupFixtures, T0, TapRepo } from "./helpers/tap.ts";

vi.mock("../src/db/d1remote.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/d1remote.ts")>();
  return { ...actual, d1Select: vi.fn(), d1Apply: vi.fn() };
});
afterAll(cleanupFixtures);

function formula(version: string, desc = "old", bottled = false): string {
  return `class Foo < Formula
  url "https://example.com/foo-${version}.tar.gz"
${bottled ? '  bottle do\n    sha256 arm64_sonoma: "abc"\n  end\n' : ""}
  license "MIT"
  homepage "https://example.com"

  desc "${desc}"
end
`;
}

async function full(tap: TapRepo, ref = "HEAD", scoped = false): Promise<DatabaseSync> {
  const db = openDb(":memory:");
  if (scoped) await buildCommitIndex(db, tap.source, ["foo"], ref);
  else await buildCommitIndexAll(db, tap.source, undefined, ref);
  buildSnapshots(db, tap.source);
  buildEvents(db, tap.source);
  buildPackageContributors(db, tap.source, undefined, ref);
  finalizeLatest(db, tap.source.id);
  reconcileRemovals(db, tap.source, ref);
  setCrawlState(db, tap.source.id, tap.git("rev-parse", ref), T0);
  return db;
}

function remote(db: DatabaseSync): DatabaseSync {
  let sql = "";
  exportSlice(db, (chunk) => {
    sql += chunk;
  });
  const result = new DatabaseSync(":memory:");
  result.exec(sql);
  vi.mocked(d1Select).mockImplementation((_mode, query) => result.prepare(query).all());
  vi.mocked(d1Apply).mockImplementation((_mode, batch) => {
    result.exec("BEGIN");
    try {
      result.exec(batch);
      result.exec("COMMIT");
    } catch (error) {
      result.exec("ROLLBACK");
      throw error;
    }
  });
  return result;
}

function state(db: DatabaseSync) {
  return {
    packages: db
      .prepare(
        "SELECT name, latest_version, latest_revision, latest_bottle_tags, removed_commit FROM packages ORDER BY name",
      )
      .all(),
    versions: db
      .prepare("SELECT version, revision, commit_sha FROM version_changes ORDER BY history_order")
      .all(),
    bottles: db
      .prepare("SELECT tag, started_commit, ended_commit FROM bottle_intervals ORDER BY started_at")
      .all(),
  };
}

function contributions(db: DatabaseSync, d1 = false) {
  const table = d1 ? "package_contribution_slices" : "package_contributors";
  return db
    .prepare(`SELECT c.display_name, SUM(pc.touch_count) AS touches, SUM(pc.version_count) AS versions
    FROM ${table} pc JOIN contributors c USING (contributor_key)
    GROUP BY c.contributor_key ORDER BY c.display_name`)
    .all();
}

describe("integrated package history", () => {
  it.each([false, true])(
    "retains published history through a reviewed pull merge (upstream cursor: %s)",
    async (upstreamCursor) => {
      const tap = new TapRepo();
      tap.write("Formula/f/foo.rb", formula("1.0"));
      const root = tap.commit("foo 1.0");
      tap.git("branch", "local");
      tap.write("Formula/f/foo.rb", formula("2.0", "old", true));
      const upstream2 = tap.commit(
        "foo 2.0",
        undefined,
        "Alice <1+alice@users.noreply.github.com>",
      );
      tap.write("Formula/f/foo.rb", formula("3.0"));
      const upstream3 = tap.commit(
        "foo 3.0",
        undefined,
        "Alice <1+alice@users.noreply.github.com>",
      );
      const upstreamBlob = tap.git("rev-parse", "HEAD:Formula/f/foo.rb");
      tap.git("checkout", "-q", "local");
      tap.write("Formula/f/foo.rb", formula("1.0", "local"));
      const localEdit = tap.commit(
        "foo: description",
        undefined,
        "Bob <2+bob@users.noreply.github.com>",
      );
      tap.git("merge", "--no-ff", "--no-commit", "main");
      const merge = tap.commit(
        "Merge remote-tracking branch 'origin/master'",
        undefined,
        "Carol <3+carol@users.noreply.github.com>",
      );
      tap.source.historyParents = { [merge.sha]: [localEdit.sha, upstream3.sha] };

      const local = await full(tap, upstreamCursor ? upstream2.sha : root.sha);
      const d1 = remote(local);
      const rebuilt = await full(tap);
      const scoped = await full(tap, "HEAD", true);
      crawlSince(local, tap.source, T0 + 20000);
      crawlSinceD1(tap.source, "local", T0 + 20000);
      for (const db of [rebuilt, scoped, local, d1]) {
        expect(
          db
            .prepare(
              "SELECT version, commit_sha, changed_at, subject FROM version_changes ORDER BY changed_at",
            )
            .all(),
        ).toEqual([
          { version: "1.0", commit_sha: root.sha, changed_at: root.at, subject: "foo 1.0" },
          {
            version: "2.0",
            commit_sha: upstream2.sha,
            changed_at: upstream2.at,
            subject: "foo 2.0",
          },
          {
            version: "3.0",
            commit_sha: upstream3.sha,
            changed_at: upstream3.at,
            subject: "foo 3.0",
          },
        ]);
        expect(state(db)).toEqual(state(rebuilt));
      }
      expect(
        rebuilt
          .prepare("SELECT parent_blob_sha FROM commit_index WHERE commit_sha = ?")
          .get(merge.sha),
      ).toEqual({ parent_blob_sha: upstreamBlob });
      expect(contributions(local)).toEqual(contributions(rebuilt));
      expect(contributions(d1, true)).toEqual(contributions(rebuilt));
      expect(contributions(rebuilt).map((row) => row.display_name)).not.toContain("Carol");
      expect(() => computeDelta(tap.source, localEdit.sha)).toThrow(/selected mainline/);
      for (const db of [rebuilt, scoped, local, d1]) db.close();
    },
  );

  it("derives a pull merge's deletion against the selected parent", async () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("1.0", "old", true));
    const root = tap.commit("foo 1.0");
    tap.git("branch", "local");
    tap.write("README.md", "upstream\n");
    const upstream = tap.commit("upstream metadata");
    tap.git("checkout", "-q", "local");
    tap.git("rm", "Formula/f/foo.rb");
    const removal = tap.commit("remove foo");
    tap.git("merge", "--no-ff", "-m", "pull upstream", "main");
    const merge = headSha(tap.dir);
    tap.source.historyParents = { [merge]: [removal.sha, upstream.sha] };
    const local = await full(tap, root.sha);
    const d1 = remote(local);
    const rebuilt = await full(tap);
    const scoped = await full(tap, "HEAD", true);
    crawlSince(local, tap.source, T0 + 20000);
    crawlSinceD1(tap.source, "local", T0 + 20000);
    expect(state(rebuilt).packages).toMatchObject([{ removed_commit: merge }]);
    expect(state(rebuilt).bottles).toMatchObject([{ ended_commit: merge }]);
    for (const db of [scoped, local, d1]) expect(state(db)).toEqual(state(rebuilt));
    for (const db of [rebuilt, scoped, local, d1]) db.close();
  });

  it("does not infer a parent correction from a merge subject", async () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("1.0"));
    tap.commit("foo 1.0");
    tap.git("checkout", "-q", "-b", "side");
    tap.write("Formula/f/foo.rb", formula("2.0"));
    tap.commit("foo 2.0");
    tap.write("Formula/f/foo.rb", formula("3.0"));
    tap.commit("foo 3.0");
    tap.git("checkout", "-q", "main");
    tap.git("merge", "--no-ff", "-m", "Merge remote-tracking branch 'origin/master'", "side");
    const db = await full(tap);
    expect(db.prepare("SELECT version FROM version_changes ORDER BY history_order").all()).toEqual([
      { version: "1.0" },
      { version: "3.0" },
    ]);
    db.close();
  });

  it("rejects a correction whose pinned parents do not match", async () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("1.0"));
    const root = tap.commit("foo 1.0");
    tap.source.historyParents = { [root.sha]: [root.sha, root.sha] };
    const db = openDb(":memory:");
    await expect(buildCommitIndexAll(db, tap.source)).rejects.toThrow(
      /reviewed history parents do not match/,
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM commit_index").get()).toEqual({ count: 0 });
    db.close();
  });

  it("does not attribute branch-update or mainline merge diffs to their authors", async () => {
    const tap = new TapRepo();
    for (const name of ["foo", "bar", "baz"]) tap.write(`Formula/${name}.rb`, formula("1.0"));
    tap.commit("initial packages");
    const local = await full(tap);
    const d1 = remote(local);
    tap.git("branch", "side");
    for (const name of ["bar", "baz"]) tap.write(`Formula/${name}.rb`, formula("2.0"));
    tap.commit("update bar and baz", undefined, "Bob <2+bob@users.noreply.github.com>");
    tap.git("checkout", "-q", "side");
    tap.write("Formula/foo.rb", formula("2.0"));
    tap.commit("foo 2.0", undefined, "Alice <1+alice@users.noreply.github.com>");
    tap.git("merge", "--no-ff", "--no-commit", "main");
    const update = tap.commit("Update branch", undefined, "Dave <4+dave@users.noreply.github.com>");
    tap.git("checkout", "-q", "main");
    tap.git("merge", "--no-ff", "--no-commit", "side");
    tap.commit("Merge side", undefined, "Carol <3+carol@users.noreply.github.com>");
    const rebuilt = await full(tap);
    crawlSince(local, tap.source, T0 + 10000);
    crawlSinceD1(tap.source, "local", T0 + 10000);
    expect(
      rebuilt
        .prepare("SELECT COUNT(*) AS count FROM commit_index WHERE commit_sha = ?")
        .get(update.sha),
    ).toEqual({ count: 0 });
    expect(contributions(rebuilt).map((row) => row.display_name)).toEqual([
      "Alice",
      "Bob",
      "pkgstory-test",
    ]);
    for (const db of [local, d1]) expect(state(db)).toEqual(state(rebuilt));
    expect(contributions(local)).toEqual(contributions(rebuilt));
    expect(contributions(d1, true)).toEqual(contributions(rebuilt));
    for (const db of [rebuilt, local, d1]) db.close();
  });

  it("uses the bump subject for versions and the bottle subject for bottle intervals", async () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("1.0"));
    tap.commit("foo 1.0");
    const local = await full(tap);
    const d1 = remote(local);
    tap.git("checkout", "-q", "-b", "side");
    tap.write("Formula/f/foo.rb", formula("2.0"));
    tap.commit("foo 2.0");
    tap.write("Formula/f/foo.rb", formula("2.0", "old", true));
    tap.commit("foo: update 2.0 bottle.");
    tap.git("checkout", "-q", "main");
    tap.git("merge", "--no-ff", "-m", "merge side", "side");
    const rebuilt = await full(tap);
    const scoped = await full(tap, "HEAD", true);
    crawlSince(local, tap.source, T0 + 10000);
    crawlSinceD1(tap.source, "local", T0 + 10000);
    for (const db of [rebuilt, scoped, local, d1]) {
      expect(db.prepare("SELECT subject FROM version_changes WHERE version = '2.0'").get()).toEqual(
        { subject: "foo 2.0" },
      );
      expect(db.prepare("SELECT subject FROM version_events WHERE version = '2.0'").get()).toEqual({
        subject: "foo 2.0",
      });
      expect(db.prepare("SELECT started_subject FROM bottle_intervals").get()).toEqual({
        started_subject: "foo: update 2.0 bottle.",
      });
      db.close();
    }
  });

  it("retains a subject-only bump when a three-way merge creates a new blob", async () => {
    const tap = new TapRepo();
    const content = (url: string, desc: string) =>
      `class Foo < Formula\n  url "https://example.com/${url}"\n\n  license "MIT"\n\n  homepage "https://example.com"\n\n  desc "${desc}"\nend\n`;
    tap.write("Formula/f/foo.rb", content("download", "old"));
    tap.commit("foo 1.0");
    const local = await full(tap);
    const d1 = remote(local);
    tap.git("branch", "side");
    tap.write("Formula/f/foo.rb", content("download", "new"));
    tap.commit("foo: description");
    tap.git("checkout", "-q", "side");
    tap.write("Formula/f/foo.rb", content("release", "old"));
    tap.commit("foo 2.0");
    tap.git("checkout", "-q", "main");
    tap.git("merge", "--no-ff", "-m", "merge side", "side");
    expect(tap.git("rev-parse", "HEAD:Formula/f/foo.rb")).not.toBe(
      tap.git("rev-parse", "HEAD^2:Formula/f/foo.rb"),
    );
    const rebuilt = await full(tap);
    const scoped = await full(tap, "HEAD", true);
    crawlSince(local, tap.source, T0 + 10000);
    crawlSinceD1(tap.source, "local", T0 + 10000);
    for (const db of [rebuilt, scoped, local, d1]) {
      expect(state(db).packages).toMatchObject([{ latest_version: "2.0" }]);
      expect(db.prepare("SELECT subject FROM version_changes WHERE version = '2.0'").get()).toEqual(
        { subject: "foo 2.0" },
      );
      db.close();
    }
  });

  it("hides the cursor from legacy incremental writers and rejects a legacy write", async () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("1.0"));
    const root = tap.commit("foo 1.0");
    const local = await full(tap);
    const d1 = remote(local);
    for (const db of [local, d1]) {
      expect(
        db.prepare("SELECT last_sha, mainline_sha, history_model FROM crawl_state").get(),
      ).toEqual({ last_sha: null, mainline_sha: root.sha, history_model: 2 });
      db.prepare("UPDATE crawl_state SET last_sha = ?").run(root.sha);
    }
    expect(() => crawlSince(local, tap.source, T0 + 10000)).toThrow(/rebuild and reseed/);
    expect(() => crawlSinceD1(tap.source, "local", T0 + 10000)).toThrow(/rebuild and reseed/);
    const write = vi.fn();
    expect(() => exportSlice(local, write)).toThrow(/crawl --all/);
    expect(write).not.toHaveBeenCalled();
    local.close();
    d1.close();
  });

  for (const sameMetadata of [false, true]) {
    for (const seedAfterMainBump of [false, true]) {
      it(`keeps mainline state through a stale branch (same metadata: ${sameMetadata}, later cursor: ${seedAfterMainBump})`, async () => {
        const tap = new TapRepo();
        tap.write("Formula/f/foo.rb", formula("1.0", "old", true));
        const root = tap.commit("foo 1.0");
        tap.git("branch", "side");
        tap.write("Formula/f/foo.rb", formula("1.1", sameMetadata ? "new" : "old"));
        const bump = tap.commit("foo 1.1", undefined, "Alice <1+alice@users.noreply.github.com>");
        const cursor = seedAfterMainBump ? bump.sha : root.sha;
        const local = await full(tap, cursor);
        const d1 = remote(local);
        tap.git("checkout", "-q", "side");
        tap.write("Formula/f/foo.rb", formula("1.0", "new", true));
        tap.commit("foo: description", undefined, "Bob <2+bob@users.noreply.github.com>");
        tap.git("checkout", "-q", "main");
        tap.git("merge", "--no-ff", "-m", "merge side", "side");
        expect(tap.git("diff", "HEAD^1", "HEAD").length === 0).toBe(sameMetadata);
        const rebuilt = await full(tap);
        const scoped = await full(tap, "HEAD", true);
        crawlSince(local, tap.source, T0 + 10000);
        crawlSinceD1(tap.source, "local", T0 + 10000);
        expect(state(rebuilt).versions).toEqual([
          { version: "1.0", revision: 0, commit_sha: root.sha },
          { version: "1.1", revision: 0, commit_sha: bump.sha },
        ]);
        expect(state(rebuilt).bottles).toEqual([
          { tag: "arm64_sonoma", started_commit: root.sha, ended_commit: bump.sha },
        ]);
        for (const db of [scoped, local, d1]) expect(state(db)).toEqual(state(rebuilt));
        expect(contributions(rebuilt)).toContainEqual({
          display_name: "Bob",
          touches: 1,
          versions: 0,
        });
        expect(contributions(local)).toEqual(contributions(rebuilt));
        expect(contributions(d1, true)).toEqual(contributions(rebuilt));
        for (const db of [scoped, rebuilt, local, d1]) db.close();
      });
    }
  }

  it("credits the branch bump and preserves its subject without crediting metadata as a version", async () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("1.0"));
    const root = tap.commit("foo 1.0");
    const local = await full(tap);
    const d1 = remote(local);
    tap.git("checkout", "-q", "-b", "side");
    tap.write("Formula/f/foo.rb", formula("1.1"));
    tap.commit("foo 1.1", undefined, "Alice <1+alice@users.noreply.github.com>");
    tap.write("Formula/f/foo.rb", formula("1.1", "new"));
    tap.commit("foo: description", undefined, "Bob <2+bob@users.noreply.github.com>");
    tap.git("checkout", "-q", "main");
    tap.git("merge", "--no-ff", "-m", "merge side", "side");
    const merged = headSha(tap.dir);
    const rebuilt = await full(tap);
    crawlSince(local, tap.source, T0 + 10000);
    crawlSinceD1(tap.source, "local", T0 + 10000);
    expect(state(rebuilt).versions).toEqual([
      { version: "1.0", revision: 0, commit_sha: root.sha },
      { version: "1.1", revision: 0, commit_sha: merged },
    ]);
    expect(contributions(rebuilt)).toContainEqual({
      display_name: "Alice",
      touches: 1,
      versions: 1,
    });
    expect(contributions(rebuilt)).toContainEqual({ display_name: "Bob", touches: 1, versions: 0 });
    expect(contributions(local)).toEqual(contributions(rebuilt));
    expect(contributions(d1, true)).toEqual(contributions(rebuilt));
    for (const db of [local, d1]) expect(state(db)).toEqual(state(rebuilt));
    for (const db of [rebuilt, local, d1]) db.close();
  });

  it("retains a subject-derived version from an exact merged blob", async () => {
    const tap = new TapRepo();
    tap.write("README.md", "root\n");
    tap.commit("root");
    tap.git("checkout", "-q", "-b", "side");
    tap.write(
      "Formula/f/foo.rb",
      'class Foo < Formula\n  url "https://example.com/download"\nend\n',
    );
    tap.commit("foo 2.0");
    tap.git("checkout", "-q", "main");
    tap.git("merge", "--no-ff", "-m", "merge side", "side");
    const db = await full(tap);
    expect(db.prepare("SELECT latest_version FROM packages").get()).toEqual({
      latest_version: "2.0",
    });
    db.close();
  });

  it("follows a subject-derived bump through metadata and a nested merge", async () => {
    const tap = new TapRepo();
    tap.write("README.md", "root\n");
    tap.commit("root");
    const local = await full(tap);
    const d1 = remote(local);
    tap.git("branch", "side");
    tap.git("checkout", "-q", "-b", "nested");
    const blob = 'class Foo < Formula\n  url "https://example.com/download"\nend\n';
    tap.write("Formula/f/foo.rb", blob);
    tap.commit("foo 2.0", undefined, "Alice <1+alice@users.noreply.github.com>");
    tap.write("Formula/f/foo.rb", `${blob}\n# metadata\n`);
    tap.commit("foo: metadata", undefined, "Bob <2+bob@users.noreply.github.com>");
    tap.git("checkout", "-q", "side");
    tap.git("merge", "--no-ff", "-m", "merge nested", "nested");
    tap.git("checkout", "-q", "main");
    tap.git("merge", "--no-ff", "-m", "merge side", "side");
    const rebuilt = await full(tap);
    crawlSince(local, tap.source, T0 + 10000);
    crawlSinceD1(tap.source, "local", T0 + 10000);
    expect(state(rebuilt).packages).toMatchObject([{ latest_version: "2.0" }]);
    expect(contributions(rebuilt)).toContainEqual({
      display_name: "Alice",
      touches: 1,
      versions: 1,
    });
    expect(contributions(rebuilt)).toContainEqual({ display_name: "Bob", touches: 1, versions: 0 });
    for (const db of [local, d1]) expect(state(db)).toEqual(state(rebuilt));
    expect(contributions(local)).toEqual(contributions(rebuilt));
    expect(contributions(d1, true)).toEqual(contributions(rebuilt));
    for (const db of [rebuilt, local, d1]) db.close();
  });

  it("preserves genuine reverts and does not recount an already merged branch", async () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("1.0"));
    tap.commit("foo 1.0");
    tap.git("checkout", "-q", "-b", "side");
    tap.write("Formula/f/foo.rb", formula("1.1"));
    tap.commit("foo 1.1", undefined, "Alice <1+alice@users.noreply.github.com>");
    tap.git("checkout", "-q", "main");
    tap.git("merge", "--no-ff", "-m", "merge side", "side");
    const local = await full(tap);
    const d1 = remote(local);
    tap.git("checkout", "-q", "side");
    tap.write("Formula/f/foo.rb", formula("1.2"));
    tap.commit("foo 1.2", undefined, "Bob <2+bob@users.noreply.github.com>");
    tap.git("checkout", "-q", "main");
    tap.git("merge", "--no-ff", "-m", "merge side again", "side");
    tap.write("Formula/f/foo.rb", formula("1.0"));
    tap.commit("Revert foo to 1.0");
    const rebuilt = await full(tap);
    crawlSince(local, tap.source, T0 + 10000);
    crawlSinceD1(tap.source, "local", T0 + 10000);
    expect(state(rebuilt).versions.map((row) => row.version)).toEqual(["1.0", "1.1", "1.2", "1.0"]);
    expect(contributions(rebuilt)).toContainEqual({
      display_name: "Alice",
      touches: 1,
      versions: 1,
    });
    expect(contributions(rebuilt)).toContainEqual({ display_name: "Bob", touches: 1, versions: 1 });
    for (const db of [local, d1]) expect(state(db)).toEqual(state(rebuilt));
    expect(contributions(local)).toEqual(contributions(rebuilt));
    expect(contributions(d1, true)).toEqual(contributions(rebuilt));
    for (const db of [rebuilt, local, d1]) db.close();
  });

  it("keeps removed packages removed and excludes packages confined to a branch", async () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("1.0", "old", true));
    tap.commit("foo 1.0");
    tap.git("branch", "side");
    tap.git("rm", "Formula/f/foo.rb");
    const deletion = tap.commit("foo: remove");
    const local = await full(tap);
    const d1 = remote(local);
    tap.git("checkout", "-q", "side");
    tap.write("Formula/f/foo.rb", formula("1.0", "branch metadata", true));
    tap.write("Formula/t/temporary.rb", formula("9.0"));
    tap.commit("branch edits");
    tap.git("rm", "Formula/f/foo.rb", "Formula/t/temporary.rb");
    tap.commit("remove branch packages");
    tap.git("checkout", "-q", "main");
    tap.git("merge", "--no-ff", "-m", "merge side", "side");
    const rebuilt = await full(tap);
    crawlSince(local, tap.source, T0 + 10000);
    crawlSinceD1(tap.source, "local", T0 + 10000);
    expect(state(rebuilt).packages).toMatchObject([{ name: "foo", removed_commit: deletion.sha }]);
    expect(state(rebuilt).packages).toHaveLength(1);
    for (const db of [local, d1]) expect(state(db)).toEqual(state(rebuilt));
    expect(contributions(local)).toEqual(contributions(rebuilt));
    expect(contributions(d1, true)).toEqual(contributions(rebuilt));
    for (const db of [rebuilt, local, d1]) db.close();
  });

  it("handles a relocation and later deletion delivered through merges", async () => {
    const tap = new TapRepo();
    tap.write("Formula/foo.rb", formula("1.0", "old", true));
    tap.commit("foo 1.0");
    const local = await full(tap);
    const d1 = remote(local);
    tap.git("checkout", "-q", "-b", "side");
    tap.git("rm", "Formula/foo.rb");
    tap.write("Formula/f/foo.rb", formula("1.0", "old", true));
    tap.commit("relocate foo");
    tap.git("checkout", "-q", "main");
    tap.git("merge", "--no-ff", "-m", "merge relocation", "side");
    crawlSince(local, tap.source, T0 + 10000);
    crawlSinceD1(tap.source, "local", T0 + 10000);
    expect(state(local).packages).toMatchObject([{ removed_commit: null }]);
    tap.git("checkout", "-q", "side");
    tap.git("rm", "Formula/f/foo.rb");
    tap.commit("remove foo");
    tap.git("checkout", "-q", "main");
    tap.git("merge", "--no-ff", "-m", "merge removal", "side");
    const merged = headSha(tap.dir);
    const rebuilt = await full(tap);
    crawlSince(local, tap.source, T0 + 20000);
    crawlSinceD1(tap.source, "local", T0 + 20000);
    expect(state(rebuilt).packages).toMatchObject([{ removed_commit: merged }]);
    expect(state(rebuilt).bottles).toMatchObject([{ ended_commit: merged }]);
    for (const db of [local, d1]) expect(state(db)).toEqual(state(rebuilt));
    expect(contributions(local)).toEqual(contributions(rebuilt));
    expect(contributions(d1, true)).toEqual(contributions(rebuilt));
    for (const db of [rebuilt, local, d1]) db.close();
  });

  it("rejects a reachable cursor on a side branch", () => {
    const tap = new TapRepo();
    tap.write("README.md", "root\n");
    tap.commit("root");
    tap.git("checkout", "-q", "-b", "side");
    tap.write("README.md", "branch\n");
    const cursor = tap.commit("branch");
    tap.git("checkout", "-q", "main");
    tap.git("merge", "--no-ff", "-m", "merge side", "side");
    expect(() => computeDelta(tap.source, cursor.sha)).toThrow(/selected mainline history/);
  });

  it.each([0, 1])("refuses history model %s before incremental writes or export", async (model) => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("1.0"));
    tap.commit("foo 1.0");
    const local = await full(tap);
    const d1 = remote(local);
    local.prepare("UPDATE crawl_state SET history_model = ?").run(model);
    d1.prepare("UPDATE crawl_state SET history_model = ?").run(model);
    expect(() => crawlSince(local, tap.source, T0 + 10000)).toThrow(/rebuild and reseed/);
    expect(() => crawlSinceD1(tap.source, "local", T0 + 10000)).toThrow(/rebuild and reseed/);
    d1.exec("ALTER TABLE crawl_state DROP COLUMN history_model");
    expect(() => crawlSinceD1(tap.source, "local", T0 + 10000)).toThrow(/rebuild and reseed/);
    const write = vi.fn();
    expect(() => exportSlice(local, write)).toThrow(/crawl --all/);
    expect(write).not.toHaveBeenCalled();
    for (const db of [local, d1])
      expect(db.prepare("SELECT last_crawled_at FROM crawl_state").get()).toEqual({
        last_crawled_at: T0,
      });
    local.close();
    d1.close();
  });
});
