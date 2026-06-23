import { describe, expect, it } from "vitest";
import { durationLabel, pickSpotlightStories, type SpotlightItem } from "../src/db/sitecache.ts";

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
