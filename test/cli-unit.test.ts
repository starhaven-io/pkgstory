import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.ts";
import { buildCommitIndex, buildCommitIndexAll } from "../src/crawl/commit-index.ts";
import { buildPackageContributors } from "../src/crawl/contributors.ts";
import { buildEvents } from "../src/crawl/events.ts";
import { crawlSince, crawlSinceD1 } from "../src/crawl/incremental.ts";
import { reconcileRemovals } from "../src/crawl/removals.ts";
import { buildSnapshots } from "../src/crawl/snapshot.ts";
import { ensureD1Schema } from "../src/db/d1remote.ts";
import { finalizeLatest, openDb, setCrawlState } from "../src/db/db.ts";
import { exportSlice } from "../src/db/export.ts";
import { refreshSiteCache } from "../src/db/sitecache.ts";
import { headSha } from "../src/git.ts";
import { resolveSources, type Source } from "../src/sources/index.ts";

vi.mock("../src/crawl/commit-index.ts", () => ({
  buildCommitIndex: vi.fn(),
  buildCommitIndexAll: vi.fn(),
}));
vi.mock("../src/crawl/contributors.ts", () => ({ buildPackageContributors: vi.fn() }));
vi.mock("../src/crawl/events.ts", () => ({ buildEvents: vi.fn() }));
vi.mock("../src/crawl/incremental.ts", () => ({ crawlSince: vi.fn(), crawlSinceD1: vi.fn() }));
vi.mock("../src/crawl/removals.ts", () => ({ reconcileRemovals: vi.fn() }));
vi.mock("../src/crawl/snapshot.ts", () => ({ buildSnapshots: vi.fn() }));
vi.mock("../src/db/d1remote.ts", () => ({ ensureD1Schema: vi.fn() }));
vi.mock("../src/db/db.ts", () => ({
  finalizeLatest: vi.fn(),
  openDb: vi.fn(),
  setCrawlState: vi.fn(),
}));
vi.mock("../src/db/export.ts", () => ({ exportSlice: vi.fn() }));
vi.mock("../src/db/sitecache.ts", () => ({ refreshSiteCache: vi.fn() }));
vi.mock("../src/git.ts", () => ({ headSha: vi.fn() }));
vi.mock("../src/sources/index.ts", () => ({ resolveSources: vi.fn() }));

const formulaSource: Source = {
  id: "homebrew-formula",
  label: "Formulae",
  tap: "homebrew/core",
  dir: "Formula",
  kind: "formula",
  repoDir: "/fixture/core",
  pathsFor: (name) => [`Formula/${name}.rb`],
  packageOf: () => null,
  packageReplacements: () => new Map(),
};

const caskSource: Source = {
  ...formulaSource,
  id: "homebrew-cask",
  label: "Casks",
  tap: "homebrew/cask",
  dir: "Casks",
  kind: "cask",
  repoDir: "/fixture/cask",
};

type FakeDb = DatabaseSync & { close: ReturnType<typeof vi.fn<() => void>> };

function fakeDb(
  options: {
    checkedAt?: number | null;
    top?: { source: string; name: string; n: number };
    events?: Array<{ version: string; revision: number; introduced_at: number }>;
  } = {},
): FakeDb {
  const db = {
    prepare: vi.fn((sql: string) => {
      if (sql.includes("MAX(last_crawled_at)")) {
        return { get: () => ({ at: options.checkedAt ?? null }) };
      }
      if (sql.includes("COUNT(*) AS n")) return { get: () => options.top };
      if (sql.includes("SELECT ve.version")) return { all: () => options.events ?? [] };
      throw new Error(`unexpected SQL in CLI test: ${sql}`);
    }),
    close: vi.fn<() => void>(),
  };
  return db as unknown as FakeDb;
}

const buildCommitIndexMock = vi.mocked(buildCommitIndex);
const buildCommitIndexAllMock = vi.mocked(buildCommitIndexAll);
const buildPackageContributorsMock = vi.mocked(buildPackageContributors);
const buildEventsMock = vi.mocked(buildEvents);
const buildSnapshotsMock = vi.mocked(buildSnapshots);
const crawlSinceMock = vi.mocked(crawlSince);
const crawlSinceD1Mock = vi.mocked(crawlSinceD1);
const ensureD1SchemaMock = vi.mocked(ensureD1Schema);
const exportSliceMock = vi.mocked(exportSlice);
const headShaMock = vi.mocked(headSha);
const openDbMock = vi.mocked(openDb);
const reconcileRemovalsMock = vi.mocked(reconcileRemovals);
const refreshSiteCacheMock = vi.mocked(refreshSiteCache);
const resolveSourcesMock = vi.mocked(resolveSources);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  resolveSourcesMock.mockReturnValue([formulaSource]);
  headShaMock.mockReturnValue("a".repeat(40));
  reconcileRemovalsMock.mockReturnValue(0);
  buildCommitIndexMock.mockReturnValue(0);
  buildSnapshotsMock.mockReturnValue(0);
  buildEventsMock.mockReturnValue(0);
  buildPackageContributorsMock.mockReturnValue(0);
  refreshSiteCacheMock.mockReturnValue({ packages: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("importable CLI dispatch", () => {
  it("runs the complete full-catalog pipeline and prints a sample", async () => {
    const db = fakeDb({
      checkedAt: 1_700_000_000,
      top: { source: "homebrew-formula", name: "foo", n: 2 },
      events: [
        { version: "2.0", revision: 1, introduced_at: 1_700_000_000 },
        { version: "1.0", revision: 0, introduced_at: 1_600_000_000 },
      ],
    });
    openDbMock.mockReturnValue(db);
    buildCommitIndexAllMock.mockImplementation(async (_db, _source, progress) => {
      progress?.(2, 3, 1);
      return { commits: 2, rows: 3, packages: 1 };
    });
    buildSnapshotsMock.mockImplementation((_db, _source, progress) => {
      progress?.(3, 3);
      return 3;
    });
    buildEventsMock.mockReturnValue(2);
    buildPackageContributorsMock.mockReturnValue(1);
    reconcileRemovalsMock.mockReturnValue(1);

    await main(["crawl", "--all", "--db", "fixture.db"]);

    expect(buildCommitIndexAllMock).toHaveBeenCalledWith(db, formulaSource, expect.any(Function));
    expect(buildSnapshotsMock).toHaveBeenCalledWith(db, formulaSource, expect.any(Function));
    expect(buildEventsMock).toHaveBeenCalledWith(db, formulaSource);
    expect(buildPackageContributorsMock).toHaveBeenCalledWith(db, formulaSource);
    expect(finalizeLatest).toHaveBeenCalledWith(db, formulaSource.id);
    expect(setCrawlState).toHaveBeenCalledWith(
      db,
      formulaSource.id,
      "a".repeat(40),
      expect.any(Number),
    );
    expect(db.close).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Sample — foo"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("2.0_1"));
  });

  it("runs curated and incremental local crawls", async () => {
    const db = fakeDb();
    openDbMock.mockReturnValue(db);
    reconcileRemovalsMock.mockReturnValue(2);

    await main(["crawl", "--formulae", " foo, bar , "]);
    expect(buildCommitIndexMock).toHaveBeenCalledWith(db, formulaSource, ["foo", "bar"]);
    expect(buildPackageContributorsMock).toHaveBeenCalledWith(db, formulaSource, ["foo", "bar"]);

    crawlSinceMock.mockReturnValueOnce({ status: "no-cursor", events: 0, commits: 0 });
    await main(["crawl", "--since"]);
    crawlSinceMock.mockReturnValueOnce({
      status: "ok",
      events: 2,
      commits: 3,
      head: "b".repeat(40),
    });
    await main(["crawl", "--since"]);
    crawlSinceMock.mockReturnValueOnce({
      status: "up-to-date",
      events: 0,
      commits: 0,
      head: "c".repeat(40),
    });
    await main(["crawl", "--since"]);
    expect(crawlSinceMock).toHaveBeenCalledTimes(3);
  });

  it("uses both curated demo catalogs by default", async () => {
    const db = fakeDb();
    openDbMock.mockReturnValue(db);
    resolveSourcesMock.mockReturnValue([formulaSource, caskSource]);

    await main(["crawl"]);

    expect(buildCommitIndexMock).toHaveBeenNthCalledWith(1, db, formulaSource, [
      "git",
      "wget",
      "jq",
      "node",
      "ripgrep",
      "htop",
      "curl",
      "ffmpeg",
      "terraform",
    ]);
    expect(buildCommitIndexMock).toHaveBeenNthCalledWith(2, db, caskSource, [
      "visual-studio-code",
      "firefox",
      "rectangle",
      "iterm2",
      "docker",
    ]);
  });

  it("filters crawls by source and rejects unknown source ids", async () => {
    const db = fakeDb();
    openDbMock.mockReturnValue(db);
    resolveSourcesMock.mockReturnValue([formulaSource, caskSource]);

    await main(["crawl", "--source", "homebrew-cask", "--casks", "firefox"]);
    expect(buildCommitIndexMock).toHaveBeenCalledOnce();
    expect(buildCommitIndexMock).toHaveBeenCalledWith(db, caskSource, ["firefox"]);

    const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    await expect(main(["crawl", "--source", "missing"])).rejects.toThrow("exit 1");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("runs D1 crawls and republishes cache only after a seeded source", async () => {
    resolveSourcesMock.mockReturnValue([formulaSource, caskSource]);
    crawlSinceD1Mock
      .mockReturnValueOnce({ status: "ok", events: 2, commits: 3, head: "b".repeat(40) })
      .mockReturnValueOnce({ status: "up-to-date", events: 0, commits: 0, head: "c".repeat(40) });
    refreshSiteCacheMock.mockReturnValue({ packages: 12_345 });

    await main(["crawl", "--d1", "local"]);

    expect(ensureD1SchemaMock).toHaveBeenCalledOnce();
    expect(crawlSinceD1Mock).toHaveBeenCalledTimes(2);
    expect(refreshSiteCacheMock).toHaveBeenCalledWith("local");

    vi.clearAllMocks();
    resolveSourcesMock.mockReturnValue([formulaSource]);
    crawlSinceD1Mock.mockReturnValue({ status: "no-cursor", events: 0, commits: 0 });
    await main(["crawl", "--d1", "local"]);
    expect(refreshSiteCacheMock).not.toHaveBeenCalled();
  });

  it("dispatches export, cache, help, and unknown commands", async () => {
    const db = fakeDb();
    openDbMock.mockReturnValue(db);
    exportSliceMock.mockImplementation((_db, write) => write("-- exported\n"));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await main(["export", "--db", "fixture.db"]);
    expect(stdout).toHaveBeenCalledWith("-- exported\n");
    expect(db.close).toHaveBeenCalled();

    refreshSiteCacheMock.mockReturnValue({ packages: 1234 });
    await main(["cache", "--d1", "remote"]);
    expect(ensureD1SchemaMock).toHaveBeenCalledWith("remote");
    expect(refreshSiteCacheMock).toHaveBeenCalledWith("remote", { spotlight: "rebuild" });

    await main(["help"]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("pkgstory crawl"));
    vi.mocked(console.log).mockClear();
    await main(["-h"]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("pkgstory crawl"));

    const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    await expect(main(["unknown"])).rejects.toThrow("exit 2");
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("reports crawl failures through the executable error path", async () => {
    const db = fakeDb();
    openDbMock.mockReturnValue(db);
    buildCommitIndexAllMock.mockRejectedValue(new Error("git failed"));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(main(["crawl", "--all"])).rejects.toThrow("exit 1");
    expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: "git failed" }));
    expect(exit).toHaveBeenCalledWith(1);
  });
});
