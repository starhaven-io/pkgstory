import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bottleTagLabel,
  coalesceBottleIntervals,
  decodeRouteParam,
  displayVersion,
  isKnownSource,
  isoDate,
  isoDateTime,
  lifecycleState,
  type PackageMeta,
  plusYear,
  sourceLabel,
  statusOf,
  todayISO,
  versionParts,
} from "../site/src/lib/format.ts";

const meta = (overrides: Partial<PackageMeta> = {}): PackageMeta => ({
  latestVersion: "1.0",
  latestRevision: 0,
  latestAt: 1_700_000_000,
  latestBottled: null,
  latestBottleTags: null,
  eventCount: 1,
  bottleEventCount: 0,
  bottleIntervalCount: 0,
  firstIntroducedAt: 1_700_000_000,
  removedAt: null,
  removedCommit: null,
  renamedTo: null,
  migratedTo: null,
  deprecateDate: null,
  deprecateReason: null,
  disableDate: null,
  disableReason: null,
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("site lifecycle formatting", () => {
  it("applies removal replacements before live lifecycle state", () => {
    expect(
      lifecycleState(
        meta({ removedAt: 1, renamedTo: "new-name", migratedTo: "other/tap" }),
        "2026-08-13",
      ),
    ).toBe("renamed");
    expect(lifecycleState(meta({ removedAt: 1, migratedTo: "other/tap" }), "2026-08-13")).toBe(
      "migrated",
    );
    expect(lifecycleState(meta({ removedAt: 1 }), "2026-08-13")).toBe("removed");
  });

  it("handles scheduled, deprecated, and disabled packages", () => {
    expect(lifecycleState(meta({ deprecateDate: "2099-01-01" }), "2026-08-13")).toBe("active");
    expect(lifecycleState(meta({ deprecateReason: "unmaintained" }), "2026-08-13")).toBe(
      "deprecated",
    );
    expect(
      lifecycleState(
        meta({ deprecateDate: "2020-01-01", disableDate: "2021-01-01" }),
        "2026-08-13",
      ),
    ).toBe("disabled");
    expect(statusOf(meta({ removedAt: 1 }), "2026-08-13")).toBe("r");
    expect(statusOf(meta(), "2026-08-13")).toBeNull();
  });
});

describe("bottle platform formatting", () => {
  it("labels Homebrew bottle tags by architecture and operating system", () => {
    expect(bottleTagLabel("sonoma")).toBe("macOS Sonoma 14 (x86_64)");
    expect(bottleTagLabel("arm64_sonoma")).toBe("macOS Sonoma 14 (arm64)");
    expect(bottleTagLabel("x86_64_linux")).toBe("Linux (x86_64)");
    expect(bottleTagLabel("arm64_linux")).toBe("Linux (arm64)");
    expect(bottleTagLabel("all")).toBe("All platforms");
    expect(bottleTagLabel("legacy")).toBe("Platform unspecified");
  });

  it.each([
    ["tahoe", "macOS Tahoe 26 (x86_64)"],
    ["sequoia", "macOS Sequoia 15 (x86_64)"],
    ["sonoma", "macOS Sonoma 14 (x86_64)"],
    ["ventura", "macOS Ventura 13 (x86_64)"],
    ["monterey", "macOS Monterey 12 (x86_64)"],
    ["big_sur", "macOS Big Sur 11 (x86_64)"],
    ["catalina", "macOS Catalina 10.15 (x86_64)"],
    ["mojave", "macOS Mojave 10.14 (x86_64)"],
    ["high_sierra", "macOS High Sierra 10.13 (x86_64)"],
    ["sierra", "macOS Sierra 10.12 (x86_64)"],
    ["el_capitan", "OS X El Capitan 10.11 (x86_64)"],
    ["el_capitan_or_later", "OS X El Capitan 10.11 or later (x86_64)"],
    ["yosemite", "OS X Yosemite 10.10 (x86_64)"],
    ["mavericks", "OS X Mavericks 10.9 (x86_64)"],
    ["mountain_lion", "OS X Mountain Lion 10.8 (x86_64)"],
    ["mountainlion", "OS X Mountain Lion 10.8 (x86_64)"],
    ["lion", "Mac OS X 10.7 (x86_64)"],
    ["snow_leopard", "Mac OS X 10.6 (x86_64)"],
    ["snowleopard", "Mac OS X 10.6 (x86_64)"],
    ["leopard", "Mac OS X 10.5 (x86_64)"],
    ["tiger", "Mac OS X 10.4 (x86_64)"],
    ["panther", "Mac OS X 10.3 (x86_64)"],
    ["jaguar", "Mac OS X 10.2 (x86_64)"],
    ["puma", "Mac OS X 10.1 (x86_64)"],
    ["cheetah", "Mac OS X 10.0 (x86_64)"],
  ])("uses Apple's naming for Intel release %s", (tag, label) => {
    expect(bottleTagLabel(tag)).toBe(label);
  });

  it("labels Apple silicon releases from Big Sur through Golden Gate", () => {
    expect(bottleTagLabel("arm64_big_sur")).toBe("macOS Big Sur 11 (arm64)");
    expect(bottleTagLabel("arm64_golden_gate")).toBe("macOS Golden Gate 27 (arm64)");
  });

  it("coalesces staggered jobs from one release but preserves release changes", () => {
    const shared = {
      tag: "sonoma",
      startedSubject: null,
      startedRevision: 0,
      endedSubject: null,
      endedRevision: 0,
    };
    expect(
      coalesceBottleIntervals([
        {
          ...shared,
          startedAt: 30,
          startedCommit: "c".repeat(40),
          startedVersion: "2.0",
          endedAt: null,
          endedCommit: null,
          endedVersion: null,
          endedRevision: null,
        },
        {
          ...shared,
          startedAt: 20,
          startedCommit: "b".repeat(40),
          startedVersion: "1.0",
          endedAt: 25,
          endedCommit: "d".repeat(40),
          endedVersion: "1.1",
        },
        {
          ...shared,
          startedAt: 10,
          startedCommit: "a".repeat(40),
          startedVersion: "0.9",
          endedAt: 15,
          endedCommit: "b".repeat(40),
          endedVersion: "1.0",
        },
      ]),
    ).toEqual([
      {
        ...shared,
        startedAt: 30,
        startedCommit: "c".repeat(40),
        startedVersion: "2.0",
        endedAt: null,
        endedCommit: null,
        endedVersion: null,
        endedRevision: null,
      },
      {
        ...shared,
        startedAt: 10,
        startedCommit: "a".repeat(40),
        startedVersion: "0.9",
        endedAt: 25,
        endedCommit: "d".repeat(40),
        endedVersion: "1.1",
      },
    ]);
  });

  it("does not hide same-release availability gaps longer than seven days", () => {
    const day = 24 * 60 * 60;
    const interval = (startedAt: number, endedAt: number | null) => ({
      tag: "sequoia",
      startedAt,
      startedCommit: String(startedAt).repeat(40).slice(0, 40),
      startedSubject: null,
      startedVersion: "3.4.0",
      startedRevision: 0,
      endedAt,
      endedCommit: endedAt == null ? null : String(endedAt).repeat(40).slice(0, 40),
      endedSubject: null,
      endedVersion: endedAt == null ? null : "3.4.0",
      endedRevision: endedAt == null ? null : 0,
    });
    const spans = coalesceBottleIntervals([
      interval(1, 2),
      interval(2 + 7 * day, 3 + 7 * day),
      interval(4 + 14 * day, null),
    ]);

    expect(spans).toHaveLength(2);
    expect(spans[1]).toMatchObject({ startedAt: 1, endedAt: 3 + 7 * day });
    expect(spans[0]).toMatchObject({ startedAt: 4 + 14 * day, endedAt: null });
  });

  it("does not coalesce intervals across formula revisions", () => {
    const interval = (
      startedAt: number,
      startedRevision: number,
      endedAt: number | null,
      endedRevision: number | null,
    ) => ({
      tag: "sonoma",
      startedAt,
      startedCommit: String(startedAt).repeat(40).slice(0, 40),
      startedSubject: null,
      startedVersion: "1.0",
      startedRevision,
      endedAt,
      endedCommit: endedAt == null ? null : String(endedAt).repeat(40).slice(0, 40),
      endedSubject: null,
      endedVersion: endedAt == null ? null : "1.0",
      endedRevision,
    });
    expect(
      coalesceBottleIntervals([interval(10, 0, 20, 0), interval(30, 1, null, null)]),
    ).toHaveLength(2);
  });
});

describe("site display helpers", () => {
  it("formats source and version labels", () => {
    expect(isKnownSource("homebrew-formula")).toBe(true);
    expect(isKnownSource("third-party")).toBe(false);
    expect(sourceLabel("homebrew-cask")).toBe("cask");
    expect(sourceLabel("third-party")).toBe("third-party");
    expect(displayVersion("1.2.3", 0)).toBe("1.2.3");
    expect(displayVersion("1.2.3", 2)).toBe("1.2.3_2");
    expect(versionParts("1.2.3,456", 2)).toEqual({ base: "1.2.3", meta: ",456_2" });
    expect(versionParts("1.2.3", 0)).toEqual({ base: "1.2.3", meta: "" });
  });

  it("decodes valid routes and preserves malformed escapes", () => {
    expect(decodeRouteParam("libsigc%2B%2B")).toBe("libsigc++");
    expect(decodeRouteParam("bad%escape")).toBe("bad%escape");
  });

  it("formats calendar values in UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T23:59:00Z"));
    expect(todayISO()).toBe("2026-08-13");
    expect(plusYear("2026-08-13")).toBe("2027-08-13");
    expect(isoDate(1_700_000_000)).toBe("2023-11-14");
    expect(isoDateTime(1_700_000_000)).toBe("2023-11-14 22:13 UTC");
  });
});
