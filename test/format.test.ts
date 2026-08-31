import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
  eventCount: 1,
  bottleEventCount: 0,
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
