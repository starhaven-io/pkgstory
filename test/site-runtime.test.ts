import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogJson, home } from "../site/src/lib/cache.ts";
import {
  bottleHistory,
  contributors,
  type D1,
  type D1PreparedStatement,
  getDb,
  lastChecked,
  lastCheckedBySource,
  packageMeta,
  timeline,
} from "../site/src/lib/d1.ts";
import { env, resetCloudflareEnv } from "./helpers/cloudflare-workers.ts";

interface QueryCall {
  sql: string;
  values: unknown[];
}

interface QueryResult {
  all?: unknown[];
  first?: unknown;
  error?: Error;
}

function fakeDb(resultFor: (sql: string) => QueryResult): { db: D1; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const db: D1 = {
    prepare(sql: string): D1PreparedStatement {
      const call = { sql, values: [] as unknown[] };
      calls.push(call);
      const statement: D1PreparedStatement = {
        bind(...values: unknown[]): D1PreparedStatement {
          call.values = values;
          return statement;
        },
        async all<T>(): Promise<{ results: T[] }> {
          const result = resultFor(sql);
          if (result.error) throw result.error;
          return { results: (result.all ?? []) as T[] };
        },
        async first<T>(): Promise<T | null> {
          const result = resultFor(sql);
          if (result.error) throw result.error;
          return (result.first ?? null) as T | null;
        },
      };
      return statement;
    },
  };
  return { db, calls };
}

beforeEach(resetCloudflareEnv);
afterEach(resetCloudflareEnv);

describe("site D1 helpers", () => {
  it("reads timelines through bound, paginated package queries", async () => {
    const events = [
      {
        version: "2.0",
        revision: 1,
        introducedAt: 1_700_000_000,
        commitSha: "a".repeat(40),
        subject: "foo 2.0",
      },
    ];
    const { db, calls } = fakeDb(() => ({ all: events }));
    env.DB = db;

    expect(getDb()).toBe(db);
    await expect(timeline(db, "homebrew-formula", "foo", 25, 50)).resolves.toEqual(events);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("ORDER BY ve.introduced_at DESC, ve.id DESC");
    expect(calls[0]?.values).toEqual(["homebrew-formula", "foo", 25, 50]);
  });

  it("reads bottle gains and losses through the package index", async () => {
    const rows = [
      {
        bottled: 0,
        version: "2.0",
        revision: 0,
        changedAt: 1_700_000_000,
        commitSha: "b".repeat(40),
        subject: "foo 2.0",
      },
    ];
    const { db, calls } = fakeDb(() => ({ all: rows }));
    await expect(bottleHistory(db, "homebrew-formula", "foo", 20, 40)).resolves.toEqual([
      { ...rows[0], bottled: false },
    ]);
    expect(calls[0]?.sql).toContain("ORDER BY be.changed_at DESC, be.id DESC");
    expect(calls[0]?.values).toEqual(["homebrew-formula", "foo", 20, 40]);

    const migrating = fakeDb(() => ({
      error: new Error("D1_ERROR: no such table: bottle_events"),
    }));
    await expect(bottleHistory(migrating.db, "homebrew-formula", "foo")).resolves.toEqual([]);
  });

  it("normalizes contributors and tolerates only the expected migration window", async () => {
    const contributorRow = {
      displayName: "A Maintainer",
      githubLogin: "maintainer",
      isBot: 0,
      touchCount: 3,
      versionCount: 2,
      firstAt: 1,
      lastAt: 2,
    };
    const { db, calls } = fakeDb(() => ({ all: [contributorRow] }));
    await expect(contributors(db, "homebrew-formula", "foo")).resolves.toEqual([
      { ...contributorRow, isBot: false },
    ]);
    expect(calls[0]?.values).toEqual(["homebrew-formula", "foo"]);

    const missing = fakeDb(() => ({
      error: new Error("D1_ERROR: no such table: package_contribution_slices"),
    })).db;
    await expect(contributors(missing, "homebrew-formula", "foo")).resolves.toEqual([]);

    const broken = fakeDb(() => ({ error: new Error("D1 unavailable") })).db;
    await expect(contributors(broken, "homebrew-formula", "foo")).rejects.toThrow("D1 unavailable");
  });

  it("reads package metadata and per-source crawl heartbeats", async () => {
    const meta = {
      latestVersion: "1.0",
      latestRevision: 0,
      latestAt: 100,
      latestBottled: 1,
      eventCount: 1,
      bottleEventCount: 2,
      firstIntroducedAt: 100,
      removedAt: null,
      removedCommit: null,
      renamedTo: null,
      migratedTo: null,
      deprecateDate: null,
      deprecateReason: null,
      disableDate: null,
      disableReason: null,
    };
    const { db, calls } = fakeDb((sql) => {
      if (sql.includes("FROM packages WHERE")) return { first: meta };
      if (sql.includes("MAX(last_crawled_at)")) return { first: { at: 200 } };
      if (sql.includes("SELECT source, last_crawled_at")) {
        return {
          all: [
            { source: "homebrew-formula", at: "200" },
            { source: "homebrew-cask", at: 150 },
          ],
        };
      }
      return {};
    });

    await expect(packageMeta(db, "homebrew-formula", "foo")).resolves.toEqual({
      ...meta,
      latestBottled: true,
    });
    await expect(lastChecked(db)).resolves.toBe(200);
    await expect(lastCheckedBySource(db)).resolves.toEqual(
      new Map([
        ["homebrew-formula", 200],
        ["homebrew-cask", 150],
      ]),
    );
    expect(calls[0]?.values).toEqual(["homebrew-formula", "foo"]);

    const empty = fakeDb(() => ({})).db;
    await expect(packageMeta(empty, "homebrew-formula", "missing")).resolves.toBeNull();
    await expect(lastChecked(empty)).resolves.toBeNull();
  });

  it("keeps package metadata readable while bottle columns are migrating", async () => {
    const legacy = {
      latestVersion: "1.0",
      latestRevision: 0,
      latestAt: 100,
      latestBottled: null,
      eventCount: 1,
      bottleEventCount: 0,
      firstIntroducedAt: 100,
      removedAt: null,
      removedCommit: null,
      renamedTo: null,
      migratedTo: null,
      deprecateDate: null,
      deprecateReason: null,
      disableDate: null,
      disableReason: null,
    };
    const { db, calls } = fakeDb((sql) =>
      sql.includes("latest_bottled")
        ? { error: new Error("D1_ERROR: no such column: latest_bottled") }
        : { first: legacy },
    );
    await expect(packageMeta(db, "homebrew-formula", "foo")).resolves.toEqual(legacy);
    expect(calls).toHaveLength(2);
  });
});

describe("site KV helpers", () => {
  it("returns published payloads and safe empty defaults", async () => {
    const values = new Map([
      ["catalog", '[{"n":"foo"}]'],
      ["home", '{"formulae":1,"casks":0,"spotlight":[],"recent":[],"checkedAt":123}'],
    ]);
    env.CACHE = { get: async (key: string) => values.get(key) ?? null };

    await expect(catalogJson()).resolves.toBe('[{"n":"foo"}]');
    await expect(home()).resolves.toMatchObject({ formulae: 1, checkedAt: 123 });

    values.clear();
    await expect(catalogJson()).resolves.toBe("[]");
    await expect(home()).resolves.toEqual({
      formulae: 0,
      casks: 0,
      spotlight: [],
      recent: [],
      checkedAt: null,
    });
  });
});

describe("site Worker bindings", () => {
  it("declares the D1 and KV bindings consumed by the runtime helpers", async () => {
    const config = await readFile(new URL("../site/wrangler.jsonc", import.meta.url), "utf8");

    expect(config).toMatch(/"binding":\s*"DB"/);
    expect(config).toMatch(/"binding":\s*"CACHE"/);
  });
});
