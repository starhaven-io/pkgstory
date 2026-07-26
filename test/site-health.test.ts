import { describe, expect, it } from "vitest";
// The site has no test runner of its own, and this helper is pure TS, so the
// root suite exercises it directly.
import { healthReport, KNOWN_SOURCES } from "../site/src/lib/format.ts";
import { SOURCE_IDS } from "../src/sources/index.ts";

const NOW = 1_753_300_000;
const STALE_AFTER = 2 * 60 * 60;
const SOURCES = ["homebrew-formula", "homebrew-cask"] as const;

function report(entries: Record<string, number>) {
  return healthReport(SOURCES, new Map(Object.entries(entries)), NOW, STALE_AFTER);
}

describe("healthReport", () => {
  it("is healthy only when every expected source is fresh", () => {
    const r = report({
      "homebrew-formula": NOW - 600,
      "homebrew-cask": NOW - 1200,
    });
    expect(r.stale).toBe(false);
    expect(r.sources["homebrew-formula"]).toEqual({
      checkedAt: NOW - 600,
      ageSeconds: 600,
      stale: false,
    });
    // Top-level fields report the WORST source, not the freshest.
    expect(r.checkedAt).toBe(NOW - 1200);
    expect(r.ageSeconds).toBe(1200);
  });

  it("goes stale when one source lags even while the other stays fresh", () => {
    const r = report({
      "homebrew-formula": NOW - 60,
      "homebrew-cask": NOW - 3 * 60 * 60,
    });
    expect(r.stale).toBe(true);
    expect(r.sources["homebrew-formula"]?.stale).toBe(false);
    expect(r.sources["homebrew-cask"]?.stale).toBe(true);
    expect(r.checkedAt).toBe(NOW - 3 * 60 * 60); // worst source drives the aggregate
  });

  it("treats a missing expected source as stale", () => {
    const r = report({ "homebrew-formula": NOW - 60 });
    expect(r.stale).toBe(true);
    expect(r.sources["homebrew-cask"]).toEqual({
      checkedAt: null,
      ageSeconds: null,
      stale: true,
    });
    expect(r.checkedAt).toBeNull();
    expect(r.ageSeconds).toBeNull();
  });

  it("treats an empty crawl_state as stale", () => {
    const r = report({});
    expect(r.stale).toBe(true);
    expect(r.checkedAt).toBeNull();
  });

  it("flips exactly past the threshold, not at it", () => {
    expect(report({ "homebrew-formula": NOW - STALE_AFTER, "homebrew-cask": NOW }).stale).toBe(
      false,
    );
    expect(report({ "homebrew-formula": NOW - STALE_AFTER - 1, "homebrew-cask": NOW }).stale).toBe(
      true,
    );
  });

  it("ignores extra sources not in the expected list", () => {
    const r = healthReport(
      SOURCES,
      new Map([
        ["homebrew-formula", NOW - 60],
        ["homebrew-cask", NOW - 60],
        ["retired-source", NOW - 999_999],
      ]),
      NOW,
      STALE_AFTER,
    );
    expect(r.stale).toBe(false);
    expect(Object.keys(r.sources).sort()).toEqual(["homebrew-cask", "homebrew-formula"]);
  });

  it("reads an empty expected list as unhealthy (misconfiguration, not health)", () => {
    expect(healthReport([], new Map(), NOW, STALE_AFTER).stale).toBe(true);
  });

  it("keeps the health contract aligned with every crawler source", () => {
    expect([...KNOWN_SOURCES].sort()).toEqual([...SOURCE_IDS].sort());
  });
});
