import { describe, expect, it } from "vitest";
import type { PackageMeta, VersionEvent } from "../site/src/lib/format.ts";
import {
  packageJsonNotFound,
  packageJsonPayload,
  packageJsonResponse,
  timelinePage,
} from "../site/src/lib/package-json.ts";

const event = (version: string, revision = 0): VersionEvent => ({
  version,
  revision,
  introducedAt: 1_700_000_000,
  commitSha: "a".repeat(40),
  subject: `pkg ${version}`,
});

const meta: PackageMeta = {
  latestVersion: "1.0",
  latestRevision: 2,
  latestAt: 1_600_000_000,
  latestBottled: true,
  eventCount: 501,
  bottleEventCount: 3,
  firstIntroducedAt: 1_500_000_000,
  removedAt: null,
  removedCommit: null,
  renamedTo: null,
  migratedTo: null,
  deprecateDate: "2026-01-01",
  deprecateReason: "unmaintained",
  disableDate: null,
  disableReason: null,
};

describe("package JSON route contract", () => {
  it("accepts the bare route and canonical positive integer pages", () => {
    expect(timelinePage(null)).toBe(1);
    expect(timelinePage("1")).toBe(1);
    expect(timelinePage("12")).toBe(12);
  });

  it.each(["", "0", "-1", "01", "1.0", "abc"])("rejects a malformed page value %j", (value) => {
    expect(timelinePage(value)).toBeNull();
  });

  it("uses denormalized current state and the requested source heartbeat", () => {
    const payload = packageJsonPayload({
      source: "homebrew-formula",
      name: "pkg",
      events: [event("2.0"), event("1.0")],
      bottleEvents: [
        {
          bottled: false,
          version: "2.0",
          revision: 0,
          changedAt: 1_700_000_050,
          commitSha: "b".repeat(40),
          subject: "pkg: bottle lost",
        },
      ],
      meta,
      checkedAt: 1_700_000_123,
      page: 1,
      timelineLimit: 500,
      bottlePage: 1,
      bottleHistoryLimit: 100,
      today: "2026-07-24",
    });

    expect(payload).toMatchObject({
      source: "homebrew-formula",
      name: "pkg",
      status: "deprecated",
      latest: {
        version: "1.0",
        revision: 2,
        display: "1.0_2",
        introducedAt: 1_600_000_000,
      },
      checkedAt: 1_700_000_123,
      eventCount: 501,
      bottle: {
        bottled: true,
        eventCount: 3,
        page: 1,
        totalPages: 1,
        events: [
          {
            bottled: false,
            version: "2.0",
            display: "2.0",
            changedAt: 1_700_000_050,
          },
        ],
      },
      page: 1,
      totalPages: 2,
      license: "CC-BY-4.0",
    });
  });

  it("returns no payload for an unknown package or out-of-range page", () => {
    expect(
      packageJsonPayload({
        source: "homebrew-cask",
        name: "missing",
        events: [],
        bottleEvents: [],
        meta: null,
        checkedAt: null,
        page: 2,
        timelineLimit: 500,
        bottlePage: 1,
        bottleHistoryLimit: 100,
      }),
    ).toBeNull();
  });

  it("serves CORS-open JSON with the documented cache and 404 behavior", async () => {
    const payload = packageJsonPayload({
      source: "homebrew-cask",
      name: "app",
      events: [event("3.0")],
      bottleEvents: [],
      meta: null,
      checkedAt: null,
      page: 1,
      timelineLimit: 500,
      bottlePage: 1,
      bottleHistoryLimit: 100,
    });
    if (payload === null) throw new Error("expected payload");

    const ok = packageJsonResponse(payload);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    expect(ok.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=600");
    expect(await ok.json()).toMatchObject({ name: "app", status: "active" });

    const missing = packageJsonNotFound();
    expect(missing.status).toBe(404);
    expect(missing.headers.get("access-control-allow-origin")).toBe("*");
    expect(await missing.json()).toEqual({ error: "not found" });
  });
});
