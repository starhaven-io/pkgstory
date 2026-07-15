import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Read/write the D1 database by shelling `wrangler d1 execute`. The same code drives
// `--local` (the dev D1 under site/.wrangler) and `--remote` (the deployed D1 in CI),
// so the incremental crawl is verifiable locally and unchanged in production.

export type D1Mode = "local" | "remote";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "../../site");
const DB_NAME = "pkgstory";

function run(args: string[]): string {
  // cwd = site so wrangler finds wrangler.jsonc and the local .wrangler/state.
  return execFileSync("npx", ["wrangler", "d1", "execute", DB_NAME, ...args], {
    cwd: SITE,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 128,
  });
}

export function sqlLit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    // NaN/Infinity would emit invalid SQL; fail loudly instead of corrupting a batch.
    if (!Number.isFinite(v)) throw new RangeError(`non-finite number in SQL literal: ${v}`);
    return String(v);
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function d1Select(mode: D1Mode, sql: string): Record<string, unknown>[] {
  const out = run([`--${mode}`, "--json", "--command", sql]);
  // Tolerate leading banner lines, anchored to line start so a "▲ [WARNING] …"
  // banner's own bracket can't fool it — the JSON array opens at column 0.
  const start = out.search(/^\[/m);
  if (start === -1) return [];
  const parsed = JSON.parse(out.slice(start)) as Array<{ results?: Record<string, unknown>[] }>;
  return parsed[0]?.results ?? [];
}

// Write content to a freshly-created private temp dir (mkdtemp → unique, mode 0700),
// hand the path to fn, then remove it. Avoids predictable temp-file names in the
// shared world-writable tmpdir (CodeQL js/insecure-temporary-file / CWE-377).
function withTempFile(name: string, content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pkgstory-"));
  try {
    const file = join(dir, name);
    writeFileSync(file, content);
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function d1Apply(mode: D1Mode, sql: string): void {
  withTempFile("delta.sql", sql, (file) => run([`--${mode}`, "--file", file]));
}

export function ensureD1PackageColumns(mode: D1Mode): void {
  const existing = new Set(
    d1Select(mode, "PRAGMA table_info(packages)").map((row) => String(row.name)),
  );
  const stmts: string[] = [];
  if (!existing.has("renamed_to")) stmts.push("ALTER TABLE packages ADD COLUMN renamed_to TEXT;");
  if (!existing.has("migrated_to")) stmts.push("ALTER TABLE packages ADD COLUMN migrated_to TEXT;");
  if (stmts.length) d1Apply(mode, `${stmts.join("\n")}\n`);
}

/** Add the contributor read model to an already-seeded D1 database. */
export function ensureD1ContributorTables(mode: D1Mode): void {
  const tables = new Set(
    d1Select(
      mode,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('contributors', 'package_contribution_slices', 'contributor_seeds')",
    ).map((row) => String(row.name)),
  );
  if (
    tables.has("contributors") &&
    tables.has("package_contribution_slices") &&
    tables.has("contributor_seeds")
  )
    return;

  d1Apply(
    mode,
    `CREATE TABLE IF NOT EXISTS contributors (
  contributor_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  github_login TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS package_contribution_slices (
  package_id INTEGER NOT NULL,
  contributor_key TEXT NOT NULL,
  window_start_sha TEXT NOT NULL,
  window_end_sha TEXT NOT NULL,
  touch_count INTEGER NOT NULL,
  version_count INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (package_id, contributor_key, window_start_sha)
);
CREATE TABLE IF NOT EXISTS contributor_seeds (
  source TEXT PRIMARY KEY,
  seeded_at_sha TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contribution_slices_package
  ON package_contribution_slices (package_id);
`,
  );
}

/**
 * Write a value to the site-cache KV namespace (binding CACHE in wrangler.jsonc).
 * Values can be large (the ~1 MB search index), so they go via a temp file.
 */
export function kvPut(mode: D1Mode, key: string, value: string): void {
  withTempFile(`${key}.json`, value, (file) =>
    execFileSync(
      "npx",
      ["wrangler", "kv", "key", "put", key, "--binding", "CACHE", `--${mode}`, "--path", file],
      { cwd: SITE, encoding: "utf8", maxBuffer: 1024 * 1024 * 8 },
    ),
  );
}
