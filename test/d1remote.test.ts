import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  d1Apply,
  d1Select,
  d1SelectMany,
  ensureD1BottleSchema,
  ensureD1ContributorTables,
  ensureD1PackageColumns,
  kvGet,
  kvPut,
  sqlLit,
} from "../src/db/d1remote.ts";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => "[]"),
}));

const execFileSyncMock = vi.mocked(execFileSync);

describe("Wrangler execution", () => {
  beforeEach(() => {
    execFileSyncMock.mockClear();
  });

  it("uses the lockfile-installed site binary instead of npx", () => {
    d1Select("local", "SELECT 1");

    const site = resolve(dirname(fileURLToPath(import.meta.url)), "../site");
    const wrangler = resolve(site, "node_modules/.bin/wrangler");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      wrangler,
      ["d1", "execute", "pkgstory", "--local", "--json", "--command", "SELECT 1"],
      expect.objectContaining({ cwd: site }),
    );
  });
});

describe("d1Select output parsing", () => {
  beforeEach(() => {
    execFileSyncMock.mockClear();
  });

  it("parses a plain JSON result set", () => {
    execFileSyncMock.mockReturnValueOnce('[{"results":[{"n":1},{"n":2}],"success":true}]');
    expect(d1Select("local", "SELECT n FROM t")).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("skips leading banner lines, including ones containing brackets", () => {
    execFileSyncMock.mockReturnValueOnce(
      [
        " ⛅️ wrangler 4.110.0",
        "▲ [WARNING] Processing wrangler.jsonc configuration:",
        '[{"results":[{"last_sha":"abc"}],"success":true}]',
        "",
      ].join("\n"),
    );
    expect(d1Select("local", "SELECT last_sha FROM crawl_state")).toEqual([{ last_sha: "abc" }]);
  });

  it("returns [] for a genuinely empty result set", () => {
    execFileSyncMock.mockReturnValueOnce('[{"results":[],"success":true}]');
    expect(d1Select("local", "SELECT 1 WHERE 0")).toEqual([]);
  });

  it("throws when the output contains no JSON array (never a silent [])", () => {
    // A silent [] drops the window's contributor data while the cursor advances.
    execFileSyncMock.mockReturnValueOnce("▲ [WARNING] something changed\nno json here\n");
    expect(() => d1Select("local", "SELECT 1")).toThrow(/no JSON array/);
    execFileSyncMock.mockReturnValueOnce("");
    expect(() => d1Select("local", "SELECT 1")).toThrow(/no JSON array/);
  });

  it("throws on a truncated or malformed JSON payload", () => {
    execFileSyncMock.mockReturnValueOnce('[{"results":[{"n":1}');
    expect(() => d1Select("local", "SELECT 1")).toThrow();
  });
});

describe("d1SelectMany", () => {
  beforeEach(() => {
    execFileSyncMock.mockClear();
  });

  it("runs all statements in one wrangler spawn and maps results per statement", () => {
    execFileSyncMock.mockReturnValueOnce(
      '[{"results":[{"a":1}],"success":true},{"results":[],"success":true},{"results":[{"c":3}],"success":true}]',
    );
    expect(d1SelectMany("local", ["SELECT a", "SELECT b", "SELECT c"])).toEqual([
      [{ a: 1 }],
      [],
      [{ c: 3 }],
    ]);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const args = execFileSyncMock.mock.calls[0]?.[1] as string[];
    expect(args[args.indexOf("--command") + 1]).toBe("SELECT a;\nSELECT b;\nSELECT c");
  });

  it("throws when the result-set count does not match the statement count", () => {
    execFileSyncMock.mockReturnValueOnce('[{"results":[{"a":1}],"success":true}]');
    expect(() => d1SelectMany("local", ["SELECT a", "SELECT b"])).toThrow(
      /1 result sets for 2 statements/,
    );
  });

  it("does not spawn wrangler for an empty statement list", () => {
    expect(d1SelectMany("local", [])).toEqual([]);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});

describe("d1Apply", () => {
  beforeEach(() => {
    execFileSyncMock.mockClear();
  });

  it("ships the SQL through a temp file that is removed afterwards", () => {
    let seenPath = "";
    let seenContent = "";
    execFileSyncMock.mockImplementationOnce(((_bin: string, args: string[]) => {
      seenPath = args[args.indexOf("--file") + 1] ?? "";
      seenContent = readFileSync(seenPath, "utf8");
      return "";
    }) as never);

    d1Apply("local", "UPDATE t SET x = 1;\n");

    const args = execFileSyncMock.mock.calls[0]?.[1] as string[];
    expect(args.slice(0, 3)).toEqual(["d1", "execute", "pkgstory"]);
    expect(args).toContain("--local");
    expect(seenContent).toBe("UPDATE t SET x = 1;\n");
    expect(() => readFileSync(seenPath)).toThrow(); // private temp dir cleaned up
  });
});

describe("ensure* schema probes", () => {
  beforeEach(() => {
    execFileSyncMock.mockClear();
  });

  it("adds only the missing package columns", () => {
    execFileSyncMock.mockReturnValueOnce(
      '[{"results":[{"name":"id"},{"name":"renamed_to"},{"name":"latest_bottled"},{"name":"bottle_event_count"}],"success":true}]',
    );
    let applied = "";
    execFileSyncMock.mockImplementationOnce(((_bin: string, args: string[]) => {
      applied = readFileSync(args[args.indexOf("--file") + 1] ?? "", "utf8");
      return "";
    }) as never);

    ensureD1PackageColumns("local");
    expect(applied).toBe(
      "ALTER TABLE packages ADD COLUMN migrated_to TEXT;\nALTER TABLE packages ADD COLUMN latest_bottle_tags TEXT;\nALTER TABLE packages ADD COLUMN bottle_interval_count INTEGER NOT NULL DEFAULT 0;\n",
    );
  });

  it("does nothing when the package columns already exist", () => {
    execFileSyncMock.mockReturnValueOnce(
      '[{"results":[{"name":"renamed_to"},{"name":"migrated_to"},{"name":"latest_bottled"},{"name":"bottle_event_count"},{"name":"latest_bottle_tags"},{"name":"bottle_interval_count"}],"success":true}]',
    );
    ensureD1PackageColumns("local");
    expect(execFileSyncMock).toHaveBeenCalledTimes(1); // probe only, no apply
  });

  it("creates the contributor tables only when any is missing", () => {
    execFileSyncMock.mockReturnValueOnce(
      '[{"results":[{"name":"contributors"},{"name":"package_contribution_slices"},{"name":"contributor_seeds"}],"success":true}]',
    );
    ensureD1ContributorTables("local");
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);

    execFileSyncMock.mockClear();
    execFileSyncMock.mockReturnValueOnce('[{"results":[{"name":"contributors"}],"success":true}]');
    let applied = "";
    execFileSyncMock.mockImplementationOnce(((_bin: string, args: string[]) => {
      applied = readFileSync(args[args.indexOf("--file") + 1] ?? "", "utf8");
      return "";
    }) as never);
    ensureD1ContributorTables("local");
    expect(applied).toContain("CREATE TABLE IF NOT EXISTS package_contribution_slices");
    expect(applied).toContain("CREATE TABLE IF NOT EXISTS contributor_seeds");
  });

  it("creates the bottle tables only when either is missing", () => {
    execFileSyncMock.mockReturnValueOnce(
      '[{"results":[{"name":"bottle_events"},{"name":"bottle_intervals"}],"success":true}]',
    );
    execFileSyncMock.mockReturnValueOnce(
      '[{"results":[{"name":"started_version"},{"name":"started_revision"},{"name":"ended_version"},{"name":"ended_revision"}],"success":true}]',
    );
    ensureD1BottleSchema("local");
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);

    execFileSyncMock.mockClear();
    execFileSyncMock.mockReturnValueOnce('[{"results":[],"success":true}]');
    let applied = "";
    execFileSyncMock.mockImplementationOnce(((_bin: string, args: string[]) => {
      applied = readFileSync(args[args.indexOf("--file") + 1] ?? "", "utf8");
      return "";
    }) as never);
    ensureD1BottleSchema("local");
    expect(applied).toContain("CREATE TABLE IF NOT EXISTS bottle_events");
    expect(applied).toContain("CREATE TABLE IF NOT EXISTS bottle_intervals");
    expect(applied).toContain("idx_bottle_events_pkg_time");
    expect(applied).toContain("idx_bottle_intervals_pkg_time");
  });

  it("adds bottle interval boundary-version columns to an existing table", () => {
    execFileSyncMock.mockReturnValueOnce(
      '[{"results":[{"name":"bottle_events"},{"name":"bottle_intervals"}],"success":true}]',
    );
    execFileSyncMock.mockReturnValueOnce(
      '[{"results":[{"name":"id"},{"name":"started_version"}],"success":true}]',
    );
    let applied = "";
    execFileSyncMock.mockImplementationOnce(((_bin: string, args: string[]) => {
      applied = readFileSync(args[args.indexOf("--file") + 1] ?? "", "utf8");
      return "";
    }) as never);

    ensureD1BottleSchema("local");
    expect(applied).toBe(
      "ALTER TABLE bottle_intervals ADD COLUMN started_revision INTEGER NOT NULL DEFAULT 0;\nALTER TABLE bottle_intervals ADD COLUMN ended_version TEXT;\nALTER TABLE bottle_intervals ADD COLUMN ended_revision INTEGER;\n",
    );
  });

  it("migrates an existing interval table while creating a missing event table", () => {
    execFileSyncMock.mockReturnValueOnce(
      '[{"results":[{"name":"bottle_intervals"}],"success":true}]',
    );
    const applied: string[] = [];
    execFileSyncMock.mockImplementationOnce(((_bin: string, args: string[]) => {
      applied.push(readFileSync(args[args.indexOf("--file") + 1] ?? "", "utf8"));
      return "";
    }) as never);
    execFileSyncMock.mockReturnValueOnce('[{"results":[{"name":"id"}],"success":true}]');
    execFileSyncMock.mockImplementationOnce(((_bin: string, args: string[]) => {
      applied.push(readFileSync(args[args.indexOf("--file") + 1] ?? "", "utf8"));
      return "";
    }) as never);

    ensureD1BottleSchema("local");
    expect(applied[0]).toContain("CREATE TABLE IF NOT EXISTS bottle_events");
    expect(applied[1]).toContain("ALTER TABLE bottle_intervals ADD COLUMN started_version TEXT");
  });
});

describe("kv helpers", () => {
  beforeEach(() => {
    execFileSyncMock.mockClear();
  });

  it("kvGet returns the raw value from the CACHE binding", () => {
    execFileSyncMock.mockReturnValueOnce('{"formulae":1}');
    expect(kvGet("local", "home")).toBe('{"formulae":1}');
    expect(execFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("wrangler"),
      ["kv", "key", "get", "home", "--binding", "CACHE", "--local", "--text"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("kvGet warns and fails open to null on any wrangler failure (caller rebuilds)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error("key not found");
    });
    try {
      expect(kvGet("local", "home")).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        'CACHE key "home" could not be read; rebuilding from D1: key not found',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("kvPut writes the value via a temp file to the CACHE binding", () => {
    let seenContent = "";
    execFileSyncMock.mockImplementationOnce(((_bin: string, args: string[]) => {
      seenContent = readFileSync(args[args.indexOf("--path") + 1] ?? "", "utf8");
      return "";
    }) as never);

    kvPut("remote", "catalog", "[1,2,3]");

    const args = execFileSyncMock.mock.calls[0]?.[1] as string[];
    expect(args.slice(0, 4)).toEqual(["kv", "key", "put", "catalog"]);
    expect(args).toContain("--remote");
    expect(seenContent).toBe("[1,2,3]");
  });
});

// Names, versions, commit subjects, and lifecycle reasons all flow through sqlLit
// into generated SQL, and a commit subject is writable by anyone with a merged
// Homebrew commit — escaping here is a security boundary.
describe("sqlLit", () => {
  it("maps null/undefined to NULL", () => {
    expect(sqlLit(null)).toBe("NULL");
    expect(sqlLit(undefined)).toBe("NULL");
  });

  it("passes finite numbers through bare", () => {
    expect(sqlLit(0)).toBe("0");
    expect(sqlLit(-3)).toBe("-3");
    expect(sqlLit(1700000000)).toBe("1700000000");
  });

  it("rejects non-finite numbers instead of emitting invalid SQL", () => {
    expect(() => sqlLit(Number.NaN)).toThrow(RangeError);
    expect(() => sqlLit(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("doubles single quotes (the only escape SQLite literals need)", () => {
    expect(sqlLit("o'brien")).toBe("'o''brien'");
    expect(sqlLit("'';--")).toBe("''''';--'");
  });

  it("leaves injection-shaped content inert inside the literal", () => {
    expect(sqlLit("x'); DROP TABLE packages;--")).toBe("'x''); DROP TABLE packages;--'");
    expect(sqlLit("a;b")).toBe("'a;b'");
    expect(sqlLit("line1\nline2")).toBe("'line1\nline2'");
  });

  it("strips C0 control characters (a NUL would break the SQL file parse)", () => {
    expect(sqlLit("a\x00b")).toBe("'ab'");
    expect(sqlLit("esc\x1b[31mred")).toBe("'esc[31mred'");
    expect(sqlLit("bell\x07 backspace\x08 delete\x7f")).toBe("'bell backspace delete'");
    expect(sqlLit("cr\r\nlf")).toBe("'cr\nlf'");
    expect(sqlLit("keep\ttabs\nand newlines")).toBe("'keep\ttabs\nand newlines'");
  });
});
