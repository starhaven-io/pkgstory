import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { d1Select, sqlLit } from "../src/db/d1remote.ts";

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
});
