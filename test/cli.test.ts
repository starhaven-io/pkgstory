import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

// Real subprocess runs: mode defaulting only exists on the argv path. Every
// rejection lands before any brew/git/wrangler probe, so these stay hermetic.
function cli(...args: string[]): CliResult {
  try {
    const stdout = execFileSync(process.execPath, ["src/cli.ts", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("cli --d1 validation", () => {
  it("rejects a mistyped crawl --d1 value instead of picking a side", () => {
    const r = cli("crawl", "--d1", "locl");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('invalid --d1 value "locl"');
  });

  it("rejects near-miss crawl --d1 values that used to fall back to local", () => {
    const r = cli("crawl", "--d1", "Remote");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('expected "local" or "remote"');
  });

  it("requires an explicit --d1 for cache (bare cache used to write production KV)", () => {
    const r = cli("cache");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("requires --d1 local or --d1 remote");
  });

  it("rejects a mistyped cache --d1 value instead of defaulting to remote", () => {
    const r = cli("cache", "--d1", "locl");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('invalid --d1 value "locl"');
  });
});

describe("cli command dispatch", () => {
  it("prints usage for help and bare invocations", () => {
    for (const args of [["help"], ["--help"], []]) {
      const r = cli(...args);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("pkgstory crawl");
      expect(r.stdout).toContain("pkgstory export");
      expect(r.stdout).toContain("pkgstory cache --d1 local|remote");
    }
  });

  it("fails on an unknown command", () => {
    const r = cli("frobnicate");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown command: frobnicate");
  });
});
