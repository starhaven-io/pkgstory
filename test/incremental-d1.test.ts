import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { crawlSinceD1 } from "../src/crawl/incremental.ts";
import { d1Apply, d1Select } from "../src/db/d1remote.ts";
import { openDb, setCrawlState } from "../src/db/db.ts";
import { exportSlice } from "../src/db/export.ts";
import { cleanupFixtures, formula, T0, TapRepo } from "./helpers/tap.ts";

// Real git fixture, scripted wrangler: the delta derivation runs for real, so
// these assert on the exact SQL batch the crawl would ship.
vi.mock("../src/db/d1remote.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/d1remote.ts")>();
  return { ...actual, d1Select: vi.fn(() => []), d1Apply: vi.fn() };
});

const d1SelectMock = vi.mocked(d1Select);
const d1ApplyMock = vi.mocked(d1Apply);

afterAll(cleanupFixtures);

interface D1State {
  cursor: string | null;
  seeded: boolean;
  baselines: Record<string, unknown>[];
  moved?: boolean;
}

function scriptD1(state: D1State): void {
  d1SelectMock.mockImplementation((_mode, sql) => {
    if (sql.startsWith("UPDATE crawl_state")) return state.moved ? [] : [{ source: "x" }];
    if (sql.includes("FROM crawl_state")) {
      return state.cursor === null ? [] : [{ last_sha: state.cursor }];
    }
    if (sql.includes("FROM contributor_seeds")) return state.seeded ? [{ "1": 1 }] : [];
    if (sql.includes("FROM packages") && sql.includes("WHERE source")) return state.baselines;
    throw new Error(`unexpected d1Select in test: ${sql}`);
  });
}

// An empty database with exactly the read-model schema a reseed creates in D1.
function d1Database(): DatabaseSync {
  const crawl = openDb(":memory:");
  let schema = "";
  exportSlice(crawl, (chunk) => {
    schema += chunk;
  });
  crawl.close();
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  return db;
}

function appliedSql(): string {
  const call = d1ApplyMock.mock.calls.at(-1);
  if (!call) throw new Error("expected a d1Apply call");
  return call[1];
}

function statements(sql: string): string[] {
  return sql
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function versionlessFormula(extra = ""): string {
  return `class Foo < Formula
  stable do
    url "https://example.com/download"
  end
${extra}end
`;
}

describe("crawlSinceD1", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    d1ApplyMock.mockReset();
  });

  it("reports no-cursor (and writes nothing) on an unseeded database", () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    tap.commit("foo 1.0");
    scriptD1({ cursor: null, seeded: false, baselines: [] });

    expect(crawlSinceD1(tap.source, "local", 1751000000)).toEqual({
      status: "no-cursor",
      events: 0,
      commits: 0,
    });
    expect(d1ApplyMock).not.toHaveBeenCalled();
  });

  it("heartbeats the cursor when already at HEAD", () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    const head = tap.commit("foo 1.0");
    scriptD1({ cursor: head.sha, seeded: true, baselines: [] });

    const r = crawlSinceD1(tap.source, "local", 1751000000);
    expect(r.status).toBe("up-to-date");
    expect(d1ApplyMock).not.toHaveBeenCalled();
    const sql = d1SelectMock.mock.calls.at(-1)?.[1] ?? "";
    expect(sql).toBe(
      `UPDATE crawl_state SET last_crawled_at = 1751000000 WHERE source = 'homebrew-formula' AND last_sha = '${head.sha}' RETURNING source`,
    );
  });

  it("refuses to heartbeat a cursor another writer moved", () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    const head = tap.commit("foo 1.0");
    scriptD1({ cursor: head.sha, seeded: true, baselines: [], moved: true });

    expect(() => crawlSinceD1(tap.source, "local", 1751000000)).toThrow(/cursor moved/);
    expect(d1ApplyMock).not.toHaveBeenCalled();
  });

  it("ships events, latest, lifecycle, contributions, and the cursor strictly last", () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    const cursor = tap.commit("foo 1.0");
    tap.write(
      "Formula/f/foo.rb",
      formula("foo", "1.1", '  deprecate! date: "2026-01-02", because: :unmaintained\n'),
    );
    const bump = tap.commit("foo 1.1");
    scriptD1({
      cursor: cursor.sha,
      seeded: true,
      baselines: [
        {
          name: "foo",
          latest_version: "1.0",
          latest_revision: 0,
          latest_bottled: 0,
          latest_bottle_tags: "[]",
          deprecate_date: null,
          deprecate_reason: null,
          disable_date: null,
          disable_reason: null,
          removed_at: null,
          removed_commit: null,
          renamed_to: null,
          migrated_to: null,
          change_order: 7,
        },
      ],
    });

    const r = crawlSinceD1(tap.source, "local", 1751000000);
    expect(r).toEqual({ status: "ok", events: 1, commits: 1, head: bump.sha });

    const sql = appliedSql();
    expect(sql).toContain(
      `INSERT OR IGNORE INTO packages (source, name) VALUES ('homebrew-formula', 'foo');`,
    );
    expect(sql).toMatch(/INSERT OR IGNORE INTO version_events[^\n]*'1\.1', 0, \d+,/);
    expect(sql).toMatch(/INSERT OR IGNORE INTO version_changes[^\n]*, 8, 'foo 1\.1'\);/);
    expect(sql).toContain(`'${bump.sha}'`);
    expect(sql).toMatch(/UPDATE packages SET latest_version = '1\.1', latest_revision = 0/);
    expect(sql).toMatch(/UPDATE packages SET deprecate_date = '2026-01-02'/);
    expect(sql).toContain("INSERT INTO contributors ");
    expect(sql).toContain("INSERT INTO package_contribution_slices ");
    expect(sql).toContain(`UPDATE contributor_seeds SET seeded_at_sha = '${bump.sha}'`);

    // Cursor last is observable defense in depth for local/mock executors; remote
    // Wrangler file imports are themselves atomic.
    const all = statements(sql);
    expect(all[0]).toContain("INSERT INTO crawl_state");
    expect(all[0]).toContain(`last_sha = '${cursor.sha}'`);
    expect(all.at(-1)).toContain(`UPDATE crawl_state SET last_sha = '${bump.sha}'`);
    expect(all.at(-1)).toContain(`AND last_sha = '${cursor.sha}'`);
  });

  it("writes no contributor rows before the full historical seed exists", () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    const cursor = tap.commit("foo 1.0");
    tap.write("Formula/f/foo.rb", formula("foo", "1.1"));
    tap.commit("foo 1.1");
    scriptD1({ cursor: cursor.sha, seeded: false, baselines: [] });

    const r = crawlSinceD1(tap.source, "local", 1751000000);
    expect(r.status).toBe("ok");
    const sql = appliedSql();
    expect(sql).not.toContain("INSERT INTO contributors ");
    expect(sql).not.toContain("package_contribution_slices");
    expect(sql).not.toContain("UPDATE contributor_seeds");
    expect(sql).toContain("INSERT OR IGNORE INTO version_events");
  });

  it("skips untouched-state packages but still moves the cursor", () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    const cursor = tap.commit("foo 1.0");
    // A metadata-only touch: same version, no lifecycle, still present.
    tap.write("Formula/f/foo.rb", formula("foo", "1.0", "  # comment only\n"));
    const head = tap.commit("foo: tweak comment");
    scriptD1({
      cursor: cursor.sha,
      seeded: false,
      baselines: [
        {
          name: "foo",
          latest_version: "1.0",
          latest_revision: 0,
          latest_bottled: 0,
          latest_bottle_tags: "[]",
          deprecate_date: null,
          deprecate_reason: null,
          disable_date: null,
          disable_reason: null,
          removed_at: null,
          removed_commit: null,
          renamed_to: null,
          migrated_to: null,
        },
      ],
    });

    const r = crawlSinceD1(tap.source, "local", 1751000000);
    expect(r).toMatchObject({ status: "ok", events: 0 });
    const all = statements(appliedSql());
    expect(all).toHaveLength(2); // only the cursor guard and the cursor advance
    expect(all[0]).toContain(`'${cursor.sha}', NULL WHERE NOT EXISTS`);
    expect(all[1]).toContain(`SET last_sha = '${head.sha}'`);
  });

  it("ships bottle loss and regain transitions without version events", () => {
    const tap = new TapRepo();
    const bottle =
      '  bottle do\n    sha256 cellar: :any_skip_relocation, arm64_tahoe: "aaa"\n  end\n';
    tap.write("Formula/f/foo.rb", formula("foo", "1.0", bottle));
    const cursor = tap.commit("foo: bottled");
    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    const lost = tap.commit("foo: bottle lost");
    tap.write("Formula/f/foo.rb", formula("foo", "1.0", bottle));
    const regained = tap.commit("foo: bottle restored");
    scriptD1({
      cursor: cursor.sha,
      seeded: false,
      baselines: [
        {
          name: "foo",
          latest_version: "1.0",
          latest_revision: 0,
          latest_bottled: 1,
          latest_bottle_tags: '["arm64_tahoe"]',
          deprecate_date: null,
          deprecate_reason: null,
          disable_date: null,
          disable_reason: null,
          removed_at: null,
          removed_commit: null,
          renamed_to: null,
          migrated_to: null,
        },
      ],
    });

    expect(crawlSinceD1(tap.source, "local", 1751000000)).toEqual({
      status: "ok",
      events: 0,
      commits: 2,
      head: regained.sha,
    });
    const sql = appliedSql();
    expect(sql).toContain(
      `bottle_events (package_id, bottled, version, revision, changed_at, commit_sha, subject) VALUES`,
    );
    expect(sql).toContain(`, 0, '1.0', 0, ${lost.at}, '${lost.sha}', 'foo: bottle lost')`);
    expect(sql).toContain(
      `, 1, '1.0', 0, ${regained.at}, '${regained.sha}', 'foo: bottle restored')`,
    );
    expect(sql).toContain(
      `UPDATE bottle_intervals SET ended_at = ${lost.at}, ended_commit = '${lost.sha}'`,
    );
    expect(sql).toContain("ended_version = '1.0', ended_revision = 0");
    expect(sql).toContain(
      `AND tag = 'arm64_tahoe' AND ended_at IS NULL AND started_commit NOT IN ('${regained.sha}')`,
    );
    expect(sql).toContain(`closed.ended_commit = '${lost.sha}'`);
    expect(sql).toContain(
      `INSERT OR IGNORE INTO bottle_intervals (package_id, tag, started_at, started_commit, started_subject, started_version, started_revision) VALUES`,
    );
    expect(sql).toContain(
      `'arm64_tahoe', ${regained.at}, '${regained.sha}', 'foo: bottle restored', '1.0', 0`,
    );
    expect(sql).not.toContain("INSERT OR IGNORE INTO version_events");
    expect(sql).toContain("UPDATE packages SET latest_bottled = 1");
    expect(sql).toContain(`latest_bottle_tags = '["arm64_tahoe"]'`);
    expect(statements(sql).at(-1)).toContain(`'${regained.sha}'`);
  });

  it("applies nothing when another writer moves the cursor mid-crawl", () => {
    const tap = new TapRepo();
    const db = d1Database();
    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    const cursor = tap.commit("foo 1.0");
    tap.write("Formula/f/foo.rb", formula("foo", "1.1"));
    const bump = tap.commit("foo 1.1");
    setCrawlState(db, tap.source.id, cursor.sha, T0);
    d1SelectMock.mockImplementation((_mode, sql) => db.prepare(sql).all());
    const events = () => db.prepare("SELECT version FROM version_events ORDER BY id").all();
    const lastSha = () =>
      db.prepare("SELECT last_sha FROM crawl_state WHERE source = ?").get(tap.source.id);

    // A reseed lands between the crawl's cursor read and its import.
    d1ApplyMock.mockImplementationOnce((_mode, sql) => {
      setCrawlState(db, tap.source.id, bump.sha, T0 + 1);
      db.exec(sql);
    });
    expect(() => crawlSinceD1(tap.source, "local", T0 + 2)).toThrow(/NOT NULL/);
    expect(events()).toEqual([]);
    expect(lastSha()).toEqual({ last_sha: bump.sha });

    setCrawlState(db, tap.source.id, cursor.sha, T0 + 3);
    d1ApplyMock.mockImplementationOnce((_mode, sql) => {
      db.exec(sql);
    });
    crawlSinceD1(tap.source, "local", T0 + 4);
    expect(events()).toEqual([{ version: "1.1" }]);
    expect(lastSha()).toEqual({ last_sha: bump.sha });
    db.close();
  });

  it.each([true, false])(
    "keeps backdated intervals correct on replay (known baseline: %s)",
    (known) => {
      const tap = new TapRepo();
      const db = openDb(":memory:");
      const bottle = '  bottle do\n    sha256 cellar: :any, arm64_sonoma: "aaa"\n  end\n';
      tap.write("Formula/f/foo.rb", formula("foo", "1.0", bottle));
      const cursor = tap.commit("foo: bottled");
      db.prepare(
        "INSERT INTO packages (id, source, name, latest_version, latest_revision, latest_bottled, latest_bottle_tags) VALUES (1, ?, 'foo', '1.0', 0, ?, ?)",
      ).run(tap.source.id, known ? 1 : null, known ? '["arm64_sonoma"]' : null);
      if (known)
        db.prepare(
          "INSERT INTO bottle_intervals (package_id, tag, started_at, started_commit) VALUES (1, 'arm64_sonoma', ?, ?)",
        ).run(cursor.at, cursor.sha);
      setCrawlState(db, tap.source.id, cursor.sha, T0);
      d1SelectMock.mockImplementation((_mode, sql) => db.prepare(sql).all());
      d1ApplyMock.mockImplementation((_mode, sql) => {
        db.exec(sql);
      });
      tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
      const lost = tap.commit("foo: bottle lost", T0 - 100);
      tap.write("Formula/f/foo.rb", formula("foo", "1.0", bottle));
      const regained = tap.commit("foo: bottle restored", T0 - 200);
      const intervals = () =>
        db.prepare("SELECT started_commit, ended_commit FROM bottle_intervals ORDER BY id").all();
      const expected = [
        ...(known ? [{ started_commit: cursor.sha, ended_commit: lost.sha }] : []),
        { started_commit: regained.sha, ended_commit: null },
      ];

      crawlSinceD1(tap.source, "local", T0 + 1);
      expect(intervals()).toEqual(expected);
      setCrawlState(db, tap.source.id, cursor.sha, T0 + 2);
      crawlSinceD1(tap.source, "local", T0 + 3);
      expect(intervals()).toEqual(expected);
      db.close();
    },
  );

  it("ships a versionless bottle transition from a known baseline", () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", versionlessFormula());
    const cursor = tap.commit("foo: new formula");
    tap.write("Formula/f/foo.rb", versionlessFormula('  bottle do\n    sha1 "abc"\n  end\n'));
    const gained = tap.commit("foo: add bottle");
    scriptD1({
      cursor: cursor.sha,
      seeded: false,
      baselines: [
        {
          name: "foo",
          latest_version: null,
          latest_revision: 0,
          latest_bottled: 0,
          latest_bottle_tags: "[]",
          deprecate_date: null,
          deprecate_reason: null,
          disable_date: null,
          disable_reason: null,
          removed_at: null,
          removed_commit: null,
          renamed_to: null,
          migrated_to: null,
        },
      ],
    });

    expect(crawlSinceD1(tap.source, "local", 1751000000)).toEqual({
      status: "ok",
      events: 0,
      commits: 1,
      head: gained.sha,
    });
    const sql = appliedSql();
    expect(sql).toContain(`, 1, NULL, 0, ${gained.at}, '${gained.sha}', 'foo: add bottle')`);
    expect(sql).not.toContain("INSERT OR IGNORE INTO version_events");
    expect(sql).toContain("UPDATE packages SET latest_bottled = 1");
  });

  it("establishes an existing unknown bottle baseline without fabricating an event", () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", versionlessFormula());
    const cursor = tap.commit("foo: new formula");
    tap.write("Formula/f/foo.rb", versionlessFormula('  bottle do\n    sha1 "abc"\n  end\n'));
    const head = tap.commit("foo: metadata touch");
    scriptD1({
      cursor: cursor.sha,
      seeded: false,
      baselines: [
        {
          name: "foo",
          latest_version: null,
          latest_revision: 0,
          latest_bottled: null,
          latest_bottle_tags: null,
          deprecate_date: null,
          deprecate_reason: null,
          disable_date: null,
          disable_reason: null,
          removed_at: null,
          removed_commit: null,
          renamed_to: null,
          migrated_to: null,
        },
      ],
    });

    expect(crawlSinceD1(tap.source, "local", 1751000000)).toMatchObject({
      status: "ok",
      events: 0,
      head: head.sha,
    });
    const sql = appliedSql();
    expect(sql).not.toContain("INSERT OR IGNORE INTO bottle_events");
    expect(sql).not.toContain("INSERT OR IGNORE INTO version_events");
    expect(sql).toContain("UPDATE packages SET latest_bottled = 1");
  });

  it("clears stale removal metadata when a package is restored", () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    const cursor = tap.commit("foo 1.0");
    tap.git("rm", "-q", "Formula/f/foo.rb");
    const removal = tap.commit("remove foo");
    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    const restored = tap.commit("restore foo");
    scriptD1({
      cursor: cursor.sha,
      seeded: false,
      baselines: [
        {
          name: "foo",
          latest_version: "1.0",
          latest_revision: 0,
          latest_bottled: 0,
          latest_bottle_tags: "[]",
          deprecate_date: null,
          deprecate_reason: null,
          disable_date: null,
          disable_reason: null,
          removed_at: removal.at,
          removed_commit: removal.sha,
          renamed_to: "bar",
          migrated_to: null,
        },
      ],
    });

    expect(crawlSinceD1(tap.source, "local", 1751000000)).toEqual({
      status: "ok",
      events: 0,
      commits: 2,
      head: restored.sha,
    });
    const sql = appliedSql();
    expect(sql).toContain(
      "UPDATE packages SET removed_at = NULL, removed_commit = NULL, renamed_to = NULL, migrated_to = NULL",
    );
    expect(sql).not.toContain("INSERT OR IGNORE INTO version_events");
    expect(statements(sql).at(-1)).toContain(`'${restored.sha}'`);
  });
});
