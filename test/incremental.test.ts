import { describe, expect, it } from "vitest";
import type { ContributorAttribution } from "../src/contributors.ts";
import {
  aggregateContributions,
  type DeltaTouch,
  foldPackage,
  type HistoryTouch,
} from "../src/crawl/incremental.ts";

function touch(version: string | null, revision: number, at: number, bottled = false): DeltaTouch {
  return {
    version,
    revision,
    bottled,
    at,
    sha: "f".repeat(40),
    subject: version ? `pkg ${version}` : "pkg: metadata",
  };
}

function attribution(key: string, role: "author" | "coauthor" = "author"): ContributorAttribution {
  return { key, displayName: key, githubLogin: null, isBot: false, role };
}

function historyTouch(
  sha: string,
  at: number,
  contributors: ContributorAttribution[],
): HistoryTouch {
  return {
    at,
    blobSha: "b".repeat(40),
    sha,
    subject: "s",
    status: "M",
    deleted: false,
    contributors,
  };
}

describe("foldPackage", () => {
  it("emits nothing for an empty window", () => {
    expect(foldPackage("1.0", 0, false, false, [])).toEqual({
      events: [],
      bottleEvents: [],
      latest: null,
      bottled: null,
    });
  });

  it("skips touches matching the baseline (bottle rebuilds, metadata commits)", () => {
    const { events, latest, bottleEvents } = foldPackage("1.0", 0, false, false, [
      touch("1.0", 0, 10),
      touch("1.0", 0, 20),
    ]);
    expect(events).toEqual([]);
    expect(bottleEvents).toEqual([]);
    expect(latest).toBeNull();
  });

  it("emits one event per (version, revision) change, latest last", () => {
    const t1 = touch("1.0", 1, 10); // revision bump off the 1.0/0 baseline
    const t2 = touch("1.1", 0, 20);
    const t3 = touch("1.1", 0, 30); // same as previous — dropped
    const { events, latest } = foldPackage("1.0", 0, false, false, [t1, t2, t3]);
    expect(events).toEqual([t1, t2]);
    expect(latest).toBe(t2);
  });

  it("emits a revert as a change (latest tracks the downgrade)", () => {
    const up = touch("1.1", 0, 10);
    const back = touch("1.0", 0, 20);
    const { events, latest } = foldPackage("1.0", 0, false, false, [up, back]);
    expect(events).toEqual([up, back]);
    expect(latest).toBe(back);
  });

  it("treats a null baseline as always-changed (new package)", () => {
    const first = touch("0.1", 0, 10);
    expect(foldPackage(null, 0, null, true, [first]).events).toEqual([first]);
  });

  it("emits bottle gains and losses but ignores bottle-preserving rebuilds", () => {
    const gained = touch("1.0", 0, 10, true);
    const rebuild = touch("1.0", 0, 20, true);
    const lost = touch("1.1", 0, 30, false);
    const regained = touch("1.1", 0, 40, true);

    const folded = foldPackage("1.0", 0, false, false, [gained, rebuild, lost, regained]);
    expect(folded.bottleEvents).toEqual([gained, lost, regained]);
    expect(folded.bottled).toBe(true);
  });

  it("records a new formula that starts bottled but not one that starts unbottled", () => {
    const bottled = touch("1.0", 0, 10, true);
    expect(foldPackage(null, 0, null, true, [bottled]).bottleEvents).toEqual([bottled]);
    const versionless = touch(null, 0, 10, true);
    expect(foldPackage(null, 0, null, true, [versionless]).bottleEvents).toEqual([versionless]);
    expect(foldPackage(null, 0, null, true, [touch("1.0", 0, 10)]).bottleEvents).toEqual([]);
  });

  it("tracks bottle transitions on versionless touches", () => {
    const gained = touch(null, 0, 10, true);
    const folded = foldPackage(null, 0, false, false, [gained]);
    expect(folded.events).toEqual([]);
    expect(folded.bottleEvents).toEqual([gained]);
    expect(folded.bottled).toBe(true);
  });

  it("does not invent an initial bottle event for an existing unknown baseline", () => {
    const bottled = touch(null, 0, 10, true);
    const folded = foldPackage(null, 0, null, false, [bottled]);
    expect(folded.bottleEvents).toEqual([]);
    expect(folded.bottled).toBe(true);
  });
});

describe("aggregateContributions", () => {
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);

  it("merges touches per contributor and counts only version-changing ones", () => {
    const alice = attribution("github:alice");
    const bob = attribution("github:bob", "coauthor");
    const history = [
      historyTouch(shaA, 100, [alice, bob]),
      historyTouch(shaB, 200, [alice]), // metadata-only commit
    ];
    const versionEvents = [
      { version: "1.1", revision: 0, bottled: false, at: 100, sha: shaA, subject: "s" },
    ];

    const aggregates = aggregateContributions(history, versionEvents).sort((x, y) =>
      x.contributor.key.localeCompare(y.contributor.key),
    );
    expect(aggregates).toEqual([
      {
        contributor: alice,
        touchCount: 2,
        versionCount: 1,
        firstAt: 100,
        lastAt: 200,
      },
      {
        contributor: bob,
        touchCount: 1,
        versionCount: 1,
        firstAt: 100,
        lastAt: 100,
      },
    ]);
  });

  it("returns nothing for an empty history", () => {
    expect(aggregateContributions([], [])).toEqual([]);
  });
});
