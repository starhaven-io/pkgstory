import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildCommitIndex } from "../src/crawl/commit-index.ts";
import { buildEvents } from "../src/crawl/events.ts";
import {
  computeDelta,
  crawlSince,
  type Delta,
  type PackageDelta,
} from "../src/crawl/incremental.ts";
import { reconcileRemovals } from "../src/crawl/removals.ts";
import { buildSnapshots } from "../src/crawl/snapshot.ts";
import { finalizeLatest, openDb, setCrawlState } from "../src/db/db.ts";
import { headSha } from "../src/git.ts";
import { makeSource, type Source } from "../src/sources/index.ts";

// A throwaway git repo shaped like a tap. Config is isolated (GIT_CONFIG_GLOBAL=
// /dev/null) so a developer's gpgsign/hooksPath can't break fixture commits, and
// commit timestamps are explicit so ordering assertions are deterministic.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "pkgstory-test",
  GIT_AUTHOR_EMAIL: "test@pkgstory.invalid",
  GIT_COMMITTER_NAME: "pkgstory-test",
  GIT_COMMITTER_EMAIL: "test@pkgstory.invalid",
};

const T0 = 1750000000;
const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

class TapRepo {
  readonly dir: string;
  readonly source: Source;
  private tick = 0;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "pkgstory-tap-"));
    cleanups.push(this.dir);
    this.git("init", "-q", "-b", "main");
    this.source = makeSource(
      {
        id: "homebrew-formula",
        label: "Test tap",
        tap: "test/tap",
        dir: "Formula",
        kind: "formula",
      },
      this.dir,
    );
  }

  git(...args: string[]): string {
    return execFileSync("git", ["-C", this.dir, ...args], {
      encoding: "utf8",
      env: {
        ...GIT_ENV,
        GIT_AUTHOR_DATE: `${this.at()} +0000`,
        GIT_COMMITTER_DATE: `${this.at()} +0000`,
      },
    }).trim();
  }

  write(path: string, content: string): void {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  /** Stage everything and commit at the next (or a pinned) timestamp. */
  commit(message: string, at?: number): { sha: string; at: number } {
    this.tick += 1;
    if (at !== undefined) this.pinned = at;
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message);
    const sha = this.git("rev-parse", "HEAD");
    const time = this.pinned ?? this.at();
    this.pinned = undefined;
    return { sha, at: time };
  }

  private pinned: number | undefined;
  private at(): number {
    return this.pinned ?? T0 + this.tick * 1000;
  }
}

function formula(name: string, version: string, extra = ""): string {
  const cls = (name[0] ?? "x").toUpperCase() + name.slice(1);
  return `class ${cls} < Formula\n  url "https://example.com/${name}-${version}.tar.gz"\n${extra}end\n`;
}

function firstPackage(delta: Delta): PackageDelta {
  const pkg = delta.packages[0];
  if (!pkg) throw new Error("expected the delta to contain a package");
  return pkg;
}

describe("computeDelta (against a real git repo)", () => {
  it("parses a version bump since the cursor", () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    const cursor = tap.commit("foo 1.0");
    tap.write("Formula/f/foo.rb", formula("foo", "1.1"));
    const bump = tap.commit("foo 1.1");

    const delta = computeDelta(tap.source, cursor.sha);
    expect(delta.head).toBe(bump.sha);
    expect(delta.commits).toBe(1);
    expect(delta.packages).toHaveLength(1);
    const pkg = firstPackage(delta);
    expect(pkg.name).toBe("foo");
    expect(pkg.touches).toEqual([
      { version: "1.1", revision: 0, at: bump.at, sha: bump.sha, subject: "foo 1.1" },
    ]);
    expect(pkg.removed).toBeNull();
    expect(pkg.lifecycle).toEqual({ deprecate: null, disable: null });
  });

  it("reports nothing when the cursor is at HEAD", () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    const head = tap.commit("foo 1.0");
    expect(computeDelta(tap.source, head.sha)).toEqual({
      head: head.sha,
      commits: 0,
      packages: [],
    });
  });

  it("does not flag a relocation (delete + add in one commit) as a removal", () => {
    const tap = new TapRepo();
    tap.write("Formula/foo.rb", formula("foo", "1.0"));
    const cursor = tap.commit("foo 1.0");
    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    tap.git("rm", "-q", "Formula/foo.rb");
    tap.commit("foo: relocate to Formula/f/");

    const pkg = firstPackage(computeDelta(tap.source, cursor.sha));
    expect(pkg.removed).toBeNull();
    // The post-move blob still parses, so the relocation contributes a touch.
    expect(pkg.touches.map((t) => t.version)).toEqual(["1.0"]);
  });

  it("flags a deletion with the removing commit and keeps lifecycle untouched", () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    const cursor = tap.commit("foo 1.0");
    tap.git("rm", "-q", "Formula/f/foo.rb");
    const rm = tap.commit("foo: delete");

    const pkg = firstPackage(computeDelta(tap.source, cursor.sha));
    expect(pkg.removed).toEqual({ at: rm.at, commit: rm.sha });
    expect(pkg.touches).toEqual([]);
    expect(pkg.lifecycle).toBeNull(); // no live blob in the window — leave columns alone
  });

  it("captures deprecate!/disable! stanzas from the latest live blob", () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    const cursor = tap.commit("foo 1.0");
    tap.write(
      "Formula/f/foo.rb",
      formula("foo", "1.0", '  deprecate! date: "2026-01-02", because: :unmaintained\n'),
    );
    tap.commit("foo: deprecate");

    const pkg = firstPackage(computeDelta(tap.source, cursor.sha));
    expect(pkg.lifecycle).toEqual({
      deprecate: { date: "2026-01-02", reason: "is not maintained upstream" },
      disable: null,
    });
  });

  it("clears a removal when the package is re-added later in the window", () => {
    const tap = new TapRepo();
    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    const cursor = tap.commit("foo 1.0");
    tap.git("rm", "-q", "Formula/f/foo.rb");
    tap.commit("foo: delete");
    tap.write("Formula/f/foo.rb", formula("foo", "1.2"));
    tap.commit("foo 1.2");

    const pkg = firstPackage(computeDelta(tap.source, cursor.sha));
    expect(pkg.removed).toBeNull();
    expect(pkg.touches.map((t) => t.version)).toEqual(["1.2"]);
  });
});

describe("crawlSince (seed → incremental cycle on one db)", () => {
  it("folds new commits into events, latest, lifecycle, and removal state", () => {
    const tap = new TapRepo();
    const db = openDb(":memory:");
    const now = T0 + 999000;

    // Seed: two versions, full pipeline, cursor at HEAD.
    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    tap.commit("foo 1.0");
    tap.write("Formula/f/foo.rb", formula("foo", "1.1"));
    tap.commit("foo 1.1");
    buildCommitIndex(db, tap.source, ["foo"]);
    buildSnapshots(db, tap.source);
    buildEvents(db, tap.source);
    finalizeLatest(db, tap.source.id);
    setCrawlState(db, tap.source.id, headSha(tap.dir), now);

    // Window 1: a real bump, a no-op touch, then a deprecated bump.
    tap.write("Formula/f/foo.rb", formula("foo", "1.2"));
    tap.commit("foo 1.2");
    tap.write("Formula/f/foo.rb", formula("foo", "1.2", "  # rebuild, same version\n"));
    tap.commit("foo: rebuild bottle");
    tap.write(
      "Formula/f/foo.rb",
      formula("foo", "1.3", '  deprecate! date: "2026-02-03", because: "is replaced by bar"\n'),
    );
    tap.commit("foo 1.3");

    const r1 = crawlSince(db, tap.source, now + 1);
    expect(r1.status).toBe("ok");
    expect(r1.events).toBe(2); // 1.2 and 1.3 — the rebuild folds out

    const pkg = () =>
      db
        .prepare(
          `SELECT latest_version, event_count, deprecate_date, deprecate_reason,
                  removed_at, removed_commit
             FROM packages WHERE source = ? AND name = 'foo'`,
        )
        .get(tap.source.id) as Record<string, unknown>;
    expect(pkg()).toMatchObject({
      latest_version: "1.3",
      event_count: 4,
      deprecate_date: "2026-02-03",
      deprecate_reason: "is replaced by bar",
      removed_at: null,
    });

    // Window 2: deletion → removed, lifecycle (the "why") preserved.
    tap.git("rm", "-q", "Formula/f/foo.rb");
    const rm = tap.commit("foo: delete");
    const r2 = crawlSince(db, tap.source, now + 2);
    expect(r2.status).toBe("ok");
    expect(r2.events).toBe(0);
    expect(pkg()).toMatchObject({
      latest_version: "1.3",
      removed_at: rm.at,
      removed_commit: rm.sha,
      deprecate_date: "2026-02-03",
    });

    // Window 3: re-added → reinstated with a fresh version event.
    tap.write("Formula/f/foo.rb", formula("foo", "1.4"));
    tap.commit("foo 1.4");
    const r3 = crawlSince(db, tap.source, now + 3);
    expect(r3.events).toBe(1);
    expect(pkg()).toMatchObject({ latest_version: "1.4", removed_at: null, event_count: 5 });

    // Idle: heartbeat only.
    expect(crawlSince(db, tap.source, now + 4).status).toBe("up-to-date");
    const state = db
      .prepare("SELECT last_crawled_at FROM crawl_state WHERE source = ?")
      .get(tap.source.id) as { last_crawled_at: number };
    expect(state.last_crawled_at).toBe(now + 4);
    db.close();
  });

  it("orders same-second commits by parent order, not insertion order", () => {
    const tap = new TapRepo();
    const db = openDb(":memory:");

    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    tap.commit("foo 1.0");
    // Two version-changing commits in the same epoch second.
    const tied = T0 + 5000;
    tap.write("Formula/f/foo.rb", formula("foo", "1.1"));
    tap.commit("foo 1.1", tied);
    tap.write("Formula/f/foo.rb", formula("foo", "1.2"));
    tap.commit("foo 1.2", tied);

    buildCommitIndex(db, tap.source, ["foo"]);
    buildSnapshots(db, tap.source);
    buildEvents(db, tap.source);
    finalizeLatest(db, tap.source.id);

    const row = db.prepare("SELECT latest_version FROM packages WHERE name = 'foo'").get() as {
      latest_version: string;
    };
    expect(row.latest_version).toBe("1.2"); // the child commit, despite the timestamp tie
    db.close();
  });
});

describe("reconcileRemovals (full-crawl path)", () => {
  it("flags packages absent at HEAD and reinstates re-added ones", () => {
    const tap = new TapRepo();
    const db = openDb(":memory:");

    tap.write("Formula/f/foo.rb", formula("foo", "1.0"));
    tap.write("Formula/b/bar.rb", formula("bar", "2.0"));
    tap.commit("add foo and bar");
    tap.git("rm", "-q", "Formula/f/foo.rb");
    const rm = tap.commit("foo: delete");

    buildCommitIndex(db, tap.source, ["foo", "bar"]);
    expect(reconcileRemovals(db, tap.source)).toBe(1);

    const foo = db
      .prepare("SELECT removed_at, removed_commit FROM packages WHERE name = 'foo'")
      .get() as Record<string, unknown>;
    expect(foo).toEqual({ removed_at: rm.at, removed_commit: rm.sha });
    const bar = db.prepare("SELECT removed_at FROM packages WHERE name = 'bar'").get() as {
      removed_at: number | null;
    };
    expect(bar.removed_at).toBeNull();

    // Re-add foo: the next reconcile clears the flag.
    tap.write("Formula/f/foo.rb", formula("foo", "1.1"));
    tap.commit("foo 1.1 (restored)");
    expect(reconcileRemovals(db, tap.source)).toBe(0);
    const restored = db
      .prepare("SELECT removed_at, removed_commit FROM packages WHERE name = 'foo'")
      .get() as Record<string, unknown>;
    expect(restored).toEqual({ removed_at: null, removed_commit: null });
    db.close();
  });
});
