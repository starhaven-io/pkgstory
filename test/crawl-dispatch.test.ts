import { describe, expect, it } from "vitest";
import { checkDispatch, dispatchHealthy } from "../scripts/check-crawl-dispatch.ts";

const now = new Date("2026-10-04T08:00:00Z");
const run = {
  event: "workflow_dispatch",
  head_branch: "main",
  status: "completed",
  conclusion: "success",
  path: ".github/workflows/crawl.yml",
  actor: { login: "starhaven-bot[bot]" },
  created_at: "2026-10-04T07:00:00Z",
};
const pages = (value = run) => [{ workflow_runs: [value] }];

describe("crawl dispatch monitoring", () => {
  it("finds a recent qualifying run across pages", () => {
    expect(dispatchHealthy([{ workflow_runs: [] }, ...pages()], now)).toBe(true);
  });
  it("does not count fallback, manual, wrong branch, old rerun, or future runs", () => {
    for (const change of [
      { event: "schedule" },
      { actor: { login: "maintainer" } },
      { head_branch: "feature" },
      { path: ".github/workflows/ci.yml" },
      { created_at: "2026-10-01T07:00:00Z", updated_at: now.toISOString() },
      { created_at: "2026-10-04T09:00:00Z" },
      { created_at: "invalid" },
    ])
      expect(dispatchHealthy(pages({ ...run, ...change }), now)).toBe(false);
    for (const bad of [null, [], [{}], [{ workflow_runs: null }]]) {
      expect(() => dispatchHealthy(bad, now)).toThrow(/Unreadable/);
    }
  });
  it("counts dispatched runs independently of crawl outcome or progress", () => {
    for (const change of [
      { conclusion: "failure" },
      { conclusion: "cancelled" },
      { status: "queued", conclusion: null },
      { status: "in_progress", conclusion: null },
    ]) {
      expect(dispatchHealthy([{ workflow_runs: [{ ...run, ...change }] }], now)).toBe(true);
    }
  });
  it("alerts on unreadable runs and keeps the issue distinct from crawl failures", () => {
    const calls: string[][] = [];
    const bodies: string[] = [];
    expect(
      checkDispatch(
        "starhaven-io/pkgstory",
        (args, input) => {
          calls.push(args);
          if (args.includes("repos/starhaven-io/pkgstory/actions/workflows/crawl.yml/runs"))
            throw new Error("denied");
          if (args[0] === "api") return "[[]]";
          bodies.push(input ?? "");
          return "";
        },
        now,
      ),
    ).toBe(false);
    expect(calls.at(-1)).toContain("Hourly crawl dispatches are missing");
    expect(bodies[0]).toContain("health is unknown");
  });
  it("closes only its own bot issue after recovery", () => {
    const mutations: string[][] = [];
    const issues = [
      {
        number: 1,
        title: "Hourly crawl dispatches are missing",
        user: { login: "github-actions[bot]" },
      },
      { number: 2, title: "Crawl workflow failing", user: { login: "github-actions[bot]" } },
      { number: 3, title: "Hourly crawl dispatches are missing", user: { login: "person" } },
    ];
    expect(
      checkDispatch(
        "starhaven-io/pkgstory",
        (args) => {
          if (args[0] !== "api") {
            mutations.push(args);
            return "";
          }
          expect(args).not.toContain("status=success");
          return args.some((arg) => arg.endsWith("/runs"))
            ? JSON.stringify(pages())
            : JSON.stringify([issues]);
        },
        now,
      ),
    ).toBe(true);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.slice(0, 3)).toEqual(["issue", "close", "1"]);
  });
  it("does not mutate issues when their list cannot be read", () => {
    const mutations: string[][] = [];
    expect(() =>
      checkDispatch(
        "starhaven-io/pkgstory",
        (args) => {
          if (args[0] !== "api") {
            mutations.push(args);
            return "";
          }
          if (args.some((arg) => arg.endsWith("/runs"))) return JSON.stringify(pages());
          throw new Error("issue list unavailable");
        },
        now,
      ),
    ).toThrow("issue list unavailable");
    expect(mutations).toEqual([]);
  });

  it("does not repeat updates to an unchanged open alert", () => {
    let body = "";
    checkDispatch(
      "starhaven-io/pkgstory",
      (args, input) => {
        if (args[0] !== "api") {
          body = input ?? "";
          return "";
        }
        return args.some((arg) => arg.endsWith("/runs")) ? '[{"workflow_runs":[]}]' : "[[]]";
      },
      now,
    );
    const mutations: string[][] = [];
    const issue = {
      number: 1,
      title: "Hourly crawl dispatches are missing",
      body,
      user: { login: "github-actions[bot]" },
    };
    expect(
      checkDispatch(
        "starhaven-io/pkgstory",
        (args) => {
          if (args[0] !== "api") {
            mutations.push(args);
            return "";
          }
          return args.some((arg) => arg.endsWith("/runs"))
            ? '[{"workflow_runs":[]}]'
            : JSON.stringify([[issue]]);
        },
        now,
      ),
    ).toBe(false);
    expect(mutations).toEqual([]);
  });

  it("enforces the two-hour creation boundary", () => {
    expect(dispatchHealthy(pages({ ...run, created_at: "2026-10-04T06:00:00Z" }), now)).toBe(true);
    expect(dispatchHealthy(pages({ ...run, created_at: "2026-10-04T05:59:59Z" }), now)).toBe(false);
  });
});
