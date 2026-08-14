import { beforeEach, describe, expect, it, vi } from "vitest";
import { d1Select, d1SelectMany, kvGet, kvPut } from "../src/db/d1remote.ts";
import {
  durationLabel,
  pickSpotlightStories,
  refreshSiteCache,
  type SpotlightItem,
  statusCode,
} from "../src/db/sitecache.ts";

vi.mock("../src/db/d1remote.ts", () => ({
  d1Select: vi.fn(() => []),
  d1SelectMany: vi.fn(() => [[], [], []]),
  kvGet: vi.fn(() => null),
  kvPut: vi.fn(),
}));

function story(name: string, title: string): SpotlightItem {
  return {
    source: "homebrew-formula",
    name,
    version: "1.0.0",
    revision: 0,
    title,
    stat: "10 events",
    note: "test story",
    context: "formula",
  };
}

const TODAY = "2026-07-24";

describe("statusCode", () => {
  const active = [null, null, null, null] as const; // deprecate date/reason, disable date/reason

  it("classifies removals, with renamed outranking migrated", () => {
    expect(statusCode(100, "new-name", null, ...active, TODAY)).toBe("n");
    expect(statusCode(100, null, "other/tap", ...active, TODAY)).toBe("m");
    expect(statusCode(100, "new-name", "other/tap", ...active, TODAY)).toBe("n");
    expect(statusCode(100, null, null, ...active, TODAY)).toBe("r");
  });

  it("removal outranks any live lifecycle stanza", () => {
    expect(statusCode(100, null, null, "2020-01-01", "old", "2020-01-01", "dead", TODAY)).toBe("r");
  });

  it("disable! outranks deprecate! once both are in effect", () => {
    expect(statusCode(null, null, null, "2020-01-01", "old", "2020-01-01", "dead", TODAY)).toBe(
      "x",
    );
  });

  it("treats a future-dated stanza as scheduled, not in effect", () => {
    expect(statusCode(null, null, null, null, null, "2099-01-01", "eol", TODAY)).toBeUndefined();
    expect(statusCode(null, null, null, "2099-01-01", "eol", null, null, TODAY)).toBeUndefined();
    // A scheduled disable does not mask an in-effect deprecation.
    expect(statusCode(null, null, null, "2020-01-01", "old", "2099-01-01", "eol", TODAY)).toBe("d");
  });

  it("counts a stanza with only a reason (no date) as in effect", () => {
    expect(statusCode(null, null, null, null, "unmaintained", null, null, TODAY)).toBe("d");
    expect(statusCode(null, null, null, null, null, null, "does not build", TODAY)).toBe("x");
  });

  it("flips a dated stanza exactly on its date", () => {
    expect(statusCode(null, null, null, TODAY, null, null, null, TODAY)).toBe("d");
  });

  it("returns undefined for an active package", () => {
    expect(statusCode(null, null, null, ...active, TODAY)).toBeUndefined();
  });
});

interface HomeBlob {
  formulae: number;
  casks: number;
  spotlight: SpotlightItem[];
  recent: unknown[];
  checkedAt: number | null;
  spotlightAt: number;
}

describe("refreshSiteCache", () => {
  const d1SelectMock = vi.mocked(d1Select);
  const d1SelectManyMock = vi.mocked(d1SelectMany);
  const kvGetMock = vi.mocked(kvGet);
  const kvPutMock = vi.mocked(kvPut);

  const catalogRow = (n: string, s: "c" | "f") => ({
    n,
    s,
    v: "1.0",
    r: 0,
    c: 3,
    removed_at: null,
    renamed_to: null,
    migrated_to: null,
    deprecate_date: null,
    deprecate_reason: null,
    disable_date: null,
    disable_reason: null,
  });

  const priorHome = (spotlightAt: number): string =>
    JSON.stringify({
      formulae: 1,
      casks: 1,
      spotlight: [
        {
          source: "homebrew-formula",
          name: "cached-card",
          version: "1.0",
          revision: 0,
          title: "Most updates",
          stat: "3 events",
          note: "from the prior blob",
          context: "formula",
        },
      ],
      recent: [],
      checkedAt: 1,
      spotlightAt,
    });

  const putHome = (): HomeBlob => {
    const call = kvPutMock.mock.calls.find(([, key]) => key === "home");
    if (!call) throw new Error("expected a home kvPut");
    return JSON.parse(call[2]) as HomeBlob;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    d1SelectMock.mockReturnValue([]);
    d1SelectManyMock.mockReturnValue([
      [catalogRow("alpha", "f"), catalogRow("beta", "c")],
      [],
      [{ at: 1700000000 }],
    ]);
    kvGetMock.mockReturnValue(null);
  });

  it("publishes catalog and home from one batched D1 read", () => {
    const { packages } = refreshSiteCache("local");
    expect(packages).toBe(2);
    expect(d1SelectManyMock).toHaveBeenCalledTimes(1);
    const home = putHome();
    expect(home.formulae).toBe(1);
    expect(home.casks).toBe(1);
    expect(home.checkedAt).toBe(1700000000);
    expect(typeof home.spotlightAt).toBe("number");
    const catalogCall = kvPutMock.mock.calls.find(([, key]) => key === "catalog");
    expect(JSON.parse((catalogCall as unknown[])?.[2] as string)).toHaveLength(2);
  });

  it("publishes recent changes with their effective lifecycle state", () => {
    d1SelectManyMock.mockReturnValue([
      [catalogRow("alpha", "f"), catalogRow("old-app", "c")],
      [
        {
          source: "homebrew-formula",
          name: "alpha",
          version: "1.1",
          revision: 2,
          introducedAt: 1700000001,
          removed_at: null,
          renamed_to: null,
          migrated_to: null,
          deprecate_date: null,
          deprecate_reason: null,
          disable_date: "2020-01-01",
          disable_reason: "does not build",
        },
        {
          source: "homebrew-cask",
          name: "old-app",
          version: "2.0",
          revision: 0,
          introducedAt: 1700000000,
          removed_at: 1700000100,
          renamed_to: "new-app",
          migrated_to: null,
          deprecate_date: null,
          deprecate_reason: null,
          disable_date: null,
          disable_reason: null,
        },
      ],
      [{ at: 1700000200 }],
    ]);

    refreshSiteCache("local");

    expect(putHome().recent).toEqual([
      {
        source: "homebrew-formula",
        name: "alpha",
        version: "1.1",
        revision: 2,
        introducedAt: 1700000001,
        x: "x",
      },
      {
        source: "homebrew-cask",
        name: "old-app",
        version: "2.0",
        revision: 0,
        introducedAt: 1700000000,
        x: "n",
      },
    ]);
  });

  it("reuses a fresh published spotlight without any category scans", () => {
    const spotlightAt = Math.floor(Date.now() / 1000) - 3600;
    kvGetMock.mockReturnValue(priorHome(spotlightAt));

    refreshSiteCache("local");

    expect(d1SelectMock).not.toHaveBeenCalled(); // no window-function scans
    const home = putHome();
    expect(home.spotlight.map((s) => s.name)).toEqual(["cached-card"]);
    expect(home.spotlightAt).toBe(spotlightAt);
  });

  it("rebuilds the spotlight once the published one ages out", () => {
    const spotlightAt = Math.floor(Date.now() / 1000) - 24 * 3600;
    kvGetMock.mockReturnValue(priorHome(spotlightAt));

    refreshSiteCache("local");

    expect(d1SelectMock).toHaveBeenCalled(); // category scans ran
    expect(putHome().spotlightAt).toBeGreaterThan(spotlightAt);
  });

  it("always rebuilds when asked to (manual cache refresh after a reseed)", () => {
    kvGetMock.mockReturnValue(priorHome(Math.floor(Date.now() / 1000) - 60));

    refreshSiteCache("local", { spotlight: "rebuild" });

    expect(kvGetMock).not.toHaveBeenCalled();
    expect(d1SelectMock).toHaveBeenCalled();
  });

  it("builds one card per category, in priority order, from the D1 rows", () => {
    d1SelectManyMock.mockReturnValue([
      ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].map((n) => catalogRow(n, "f")),
      [],
      [{ at: 1700000000 }],
    ]);
    d1SelectMock.mockImplementation((_mode, sql) => {
      const pick = (name: string, extra: Record<string, unknown> = {}) => [
        { source: "homebrew-formula", name, ...extra },
      ];
      if (sql.includes("ORDER BY event_count DESC")) return pick("alpha");
      if (sql.includes("introduced_at >=")) return pick("beta", { events: 12 });
      if (sql.includes("ORDER BY gap DESC"))
        return pick("gamma", { at: 1700000000, prev_at: 1600000000, gap: 100000000 });
      if (sql.includes("ORDER BY first_at ASC")) return pick("delta", { first_at: 1000000000 });
      if (sql.includes("WHERE ve.revision > 0")) return pick("epsilon", { revisions: 5 });
      if (sql.includes("p.removed_at IS NOT NULL"))
        return pick("zeta", { removed_at: 1700000000, first_at: 1500000000 });
      return [];
    });

    refreshSiteCache("local");

    const spotlight = putHome().spotlight;
    expect(spotlight.map((s) => `${s.title}:${s.name}`)).toEqual([
      "Most updates:alpha",
      "Hottest lately:beta",
      "Longest pause:gamma",
      "Oldest trail:delta",
      "Most revisions:epsilon",
      "Retired epic:zeta",
    ]);
    expect(spotlight[0]?.stat).toBe("3 events"); // catalog event count
    expect(spotlight[1]?.stat).toBe("12 in a year");
    expect(spotlight[2]?.stat).toBe("3.2 years quiet");
    expect(spotlight[3]?.stat).toBe("since 2001-09-09");
  });

  it("uses the real reserve category stories when the core categories are empty", () => {
    d1SelectManyMock.mockReturnValue([
      [catalogRow("newcomer", "f"), catalogRow("steady", "c")],
      [],
      [{ at: 1700000000 }],
    ]);
    d1SelectMock.mockImplementation((_mode, sql) => {
      if (sql.includes("HAVING COUNT(*) >= 3")) {
        return [{ source: "homebrew-formula", name: "newcomer", first_at: 1700000000 }];
      }
      if (sql.includes("HAVING COUNT(gaps.g) >= 8")) {
        return [{ source: "homebrew-cask", name: "steady", mean_days: 14.4 }];
      }
      return [];
    });

    refreshSiteCache("local");

    expect(putHome().spotlight).toEqual([
      expect.objectContaining({
        name: "newcomer",
        title: "Newest arrival",
        stat: "added 2023-11-14",
        context: "3 events · formula",
      }),
      expect.objectContaining({
        name: "steady",
        title: "Steadiest cadence",
        stat: "~14d apart",
        context: "3 events · cask",
      }),
    ]);
  });

  it("drops category rows for packages that fell out of the catalog", () => {
    d1SelectManyMock.mockReturnValue([[catalogRow("alpha", "f")], [], [{ at: 1 }]]);
    d1SelectMock.mockImplementation((_mode, sql) => {
      if (sql.includes("ORDER BY event_count DESC")) {
        return [
          { source: "homebrew-formula", name: "ghost" }, // not in the catalog
          { source: "homebrew-formula", name: "alpha" },
        ];
      }
      return [];
    });

    refreshSiteCache("local");

    expect(putHome().spotlight.map((s) => s.name)).toEqual(["alpha"]);
  });

  it("rebuilds when the prior home blob is missing or unparsable", () => {
    kvGetMock.mockReturnValueOnce(null);
    refreshSiteCache("local");
    expect(d1SelectMock).toHaveBeenCalled();

    vi.clearAllMocks();
    d1SelectManyMock.mockReturnValue([[], [], []]);
    kvGetMock.mockReturnValue("▲ [WARNING] not json at all");
    refreshSiteCache("local");
    expect(d1SelectMock).toHaveBeenCalled();
  });
});

describe("durationLabel", () => {
  it("renders quiet gaps at useful human scales", () => {
    expect(durationLabel(3 * 86400)).toBe("3 days");
    expect(durationLabel(94 * 86400)).toBe("3 months");
    expect(durationLabel(545 * 86400)).toBe("1.5 years");
    expect(durationLabel(12 * 365 * 86400)).toBe("12 years");
  });
});

describe("pickSpotlightStories", () => {
  it("takes the first unused story from each category and dedupes across them", () => {
    const picked = pickSpotlightStories([
      () => [story("alpha", "Most updates")],
      () => [story("alpha", "Hottest lately"), story("beta", "Hottest lately")],
      () => [story("gamma", "Longest pause")],
    ]);

    expect(picked.map((p) => `${p.title}:${p.name}`)).toEqual([
      "Most updates:alpha",
      "Hottest lately:beta",
      "Longest pause:gamma",
    ]);
  });

  it("skips an empty category and fills the slot from a later reserve", () => {
    const picked = pickSpotlightStories(
      [
        () => [story("alpha", "Most updates")],
        () => [], // empty core category, e.g. no removed package in a small dataset
        () => [story("beta", "Newest arrival")], // reserve fills the gap
      ],
      2,
    );

    expect(picked.map((p) => `${p.title}:${p.name}`)).toEqual([
      "Most updates:alpha",
      "Newest arrival:beta",
    ]);
  });

  it("stops at the limit without evaluating later (reserve) categories", () => {
    let reserveEvaluated = false;
    const picked = pickSpotlightStories(
      [
        () => [story("a", "Most updates")],
        () => [story("b", "Hottest lately")],
        () => {
          reserveEvaluated = true;
          return [story("c", "Steadiest cadence")];
        },
      ],
      2,
    );

    expect(picked.map((p) => p.name)).toEqual(["a", "b"]);
    expect(reserveEvaluated).toBe(false);
  });
});
