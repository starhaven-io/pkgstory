import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { created_at: "2026-10-04T07:00:00Z", healthy: true },
    { created_at: "2026-10-01T07:00:00Z", healthy: false },
  ])("checks bot freshness locally across authors: $healthy", ({ created_at, healthy }) => {
    const mutations: string[][] = [];
    const queries: string[][] = [];
    expect(
      checkDispatch(
        "starhaven-io/pkgstory",
        (args) => {
          if (args[0] !== "api") {
            mutations.push(args);
            return "";
          }
          if (!args.some((arg) => arg.endsWith("/runs"))) return "[[]]";
          queries.push(args);
          return JSON.stringify({
            workflow_runs: [
              { ...run, actor: { login: "maintainer" } },
              { ...run, created_at },
            ],
          });
        },
        now,
      ),
    ).toBe(healthy);
    expect(queries).toEqual([
      [
        "api",
        "--method",
        "GET",
        "repos/starhaven-io/pkgstory/actions/workflows/crawl.yml/runs",
        "-f",
        "per_page=100",
        "-f",
        "page=1",
      ],
    ]);
    expect(mutations.map((args) => args.slice(0, 2))).toEqual(healthy ? [] : [["issue", "create"]]);
    if (healthy) {
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("confirms dispatch health"));
      expect(console.error).not.toHaveBeenCalled();
    } else {
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("No starhaven-bot crawl dispatch was created"),
      );
      expect(console.log).not.toHaveBeenCalled();
    }
  });

  it.each(["2026-10-04T07:00:00Z", "2026-10-04T06:00:00Z"])(
    "finds a qualifying dispatch after a full page of other runs at %s",
    (created_at) => {
      const queries: string[][] = [];
      const mutations: string[][] = [];
      expect(
        checkDispatch(
          "starhaven-io/pkgstory",
          (args) => {
            if (args[0] !== "api") {
              mutations.push(args);
              return "";
            }
            if (!args.some((arg) => arg.endsWith("/runs"))) return "[[]]";
            queries.push(args);
            return JSON.stringify({
              workflow_runs:
                queries.length === 1
                  ? Array.from({ length: 100 }, () => ({
                      ...run,
                      actor: { login: "maintainer" },
                      created_at,
                    }))
                  : [{ ...run, created_at }],
            });
          },
          now,
        ),
      ).toBe(true);
      expect(queries.map((args) => args.at(-1))).toEqual(["page=1", "page=2"]);
      expect(mutations).toEqual([]);
    },
  );

  it("stops after a qualifying dispatch on a full page", () => {
    let requests = 0;
    const mutations: string[][] = [];
    expect(
      checkDispatch(
        "starhaven-io/pkgstory",
        (args) => {
          if (args[0] !== "api") {
            mutations.push(args);
            return "";
          }
          if (!args.some((arg) => arg.endsWith("/runs"))) return "[[]]";
          return JSON.stringify({
            workflow_runs:
              ++requests === 1
                ? [
                    run,
                    ...Array.from({ length: 99 }, () => ({
                      ...run,
                      actor: { login: "maintainer" },
                    })),
                  ]
                : [],
          });
        },
        now,
      ),
    ).toBe(true);
    expect(requests).toBe(1);
    expect(mutations).toEqual([]);
  });

  it("stops after a full page crosses the two-hour window", () => {
    let requests = 0;
    const bodies: string[] = [];
    expect(
      checkDispatch(
        "starhaven-io/pkgstory",
        (args, input) => {
          if (args[0] !== "api") {
            bodies.push(input ?? "");
            return "";
          }
          if (!args.some((arg) => arg.endsWith("/runs"))) return "[[]]";
          if (++requests > 1) throw new Error("Unexpected page after the time window");
          return JSON.stringify({
            workflow_runs: [
              ...Array.from({ length: 99 }, () => ({ ...run, actor: { login: "maintainer" } })),
              { ...run, created_at: "2026-10-04T05:59:59Z" },
            ],
          });
        },
        now,
      ),
    ).toBe(false);
    expect(requests).toBe(1);
    expect(bodies).toEqual([
      expect.stringContaining("No starhaven-bot crawl dispatch was created"),
    ]);
  });

  it("reports unknown health when a later page cannot be read", () => {
    let requests = 0;
    const bodies: string[] = [];
    expect(
      checkDispatch(
        "starhaven-io/pkgstory",
        (args, input) => {
          if (args[0] !== "api") {
            bodies.push(input ?? "");
            return "";
          }
          if (!args.some((arg) => arg.endsWith("/runs"))) return "[[]]";
          if (++requests > 1) throw new Error("Second page unavailable");
          return JSON.stringify({
            workflow_runs: Array.from({ length: 100 }, () => ({
              ...run,
              actor: { login: "maintainer" },
            })),
          });
        },
        now,
      ),
    ).toBe(false);
    expect(requests).toBe(2);
    expect(bodies).toEqual([expect.stringContaining("health is unknown")]);
    expect(console.error).toHaveBeenCalledWith(
      "Could not read crawl workflow runs:",
      "Second page unavailable",
    );
  });

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
    expect(console.error).toHaveBeenCalledWith("Could not read crawl workflow runs:", "denied");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("health is unknown"));
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
            ? JSON.stringify(pages()[0])
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
          if (args.some((arg) => arg.endsWith("/runs"))) return JSON.stringify(pages()[0]);
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
        return args.some((arg) => arg.endsWith("/runs")) ? '{"workflow_runs":[]}' : "[[]]";
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
            ? '{"workflow_runs":[]}'
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
