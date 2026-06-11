import { describe, expect, it } from "vitest";
import { type DeltaEvent, foldPackage } from "../src/crawl/incremental.ts";

function touch(version: string, revision: number, at: number): DeltaEvent {
  return { version, revision, at, sha: "f".repeat(40), subject: `pkg ${version}` };
}

describe("foldPackage", () => {
  it("emits nothing for an empty window", () => {
    expect(foldPackage("1.0", 0, [])).toEqual({ events: [], latest: null });
  });

  it("skips touches matching the baseline (bottle rebuilds, metadata commits)", () => {
    const { events, latest } = foldPackage("1.0", 0, [touch("1.0", 0, 10), touch("1.0", 0, 20)]);
    expect(events).toEqual([]);
    expect(latest).toBeNull();
  });

  it("emits one event per (version, revision) change, latest last", () => {
    const t1 = touch("1.0", 1, 10); // revision bump off the 1.0/0 baseline
    const t2 = touch("1.1", 0, 20);
    const t3 = touch("1.1", 0, 30); // same as previous — dropped
    const { events, latest } = foldPackage("1.0", 0, [t1, t2, t3]);
    expect(events).toEqual([t1, t2]);
    expect(latest).toBe(t2);
  });

  it("emits a revert as a change (latest tracks the downgrade)", () => {
    const up = touch("1.1", 0, 10);
    const back = touch("1.0", 0, 20);
    const { events, latest } = foldPackage("1.0", 0, [up, back]);
    expect(events).toEqual([up, back]);
    expect(latest).toBe(back);
  });

  it("treats a null baseline as always-changed (new package)", () => {
    const first = touch("0.1", 0, 10);
    expect(foldPackage(null, 0, [first]).events).toEqual([first]);
  });
});
