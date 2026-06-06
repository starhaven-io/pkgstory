import { env } from "cloudflare:workers";
import type { PackageMeta, VersionEvent } from "./format.ts";

// Minimal D1 surface (avoids a @cloudflare/workers-types dependency). Used by the
// on-demand per-package pages, which read only one package's rows via the index.
// Catalog-wide reads (home page, search index) go through ./cache.ts (KV) instead.
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = unknown>(): Promise<{ results: T[] }>;
  first<T = unknown>(): Promise<T | null>;
}
export interface D1 {
  prepare(sql: string): D1PreparedStatement;
}

/** The D1 binding from the worker environment (Astro v6 / cloudflare:workers). */
export function getDb(): D1 {
  return (env as unknown as { DB: D1 }).DB;
}

export async function timeline(
  db: D1,
  source: string,
  name: string,
): Promise<VersionEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT ve.version, ve.revision, ve.introduced_at AS introducedAt, ve.commit_sha AS commitSha, ve.subject
         FROM version_events ve JOIN packages p ON p.id = ve.package_id
        WHERE p.source = ? AND p.name = ?
        ORDER BY ve.introduced_at DESC, ve.id DESC`,
    )
    .bind(source, name)
    .all<VersionEvent>();
  return results;
}

/** Per-package lifecycle metadata (removed / deprecated / disabled state). */
export async function packageMeta(
  db: D1,
  source: string,
  name: string,
): Promise<PackageMeta | null> {
  const row = await db
    .prepare(
      `SELECT removed_at AS removedAt, removed_commit AS removedCommit,
              lifecycle, lifecycle_date AS lifecycleDate, lifecycle_reason AS lifecycleReason
         FROM packages WHERE source = ? AND name = ?`,
    )
    .bind(source, name)
    .first<PackageMeta>();
  return row;
}

/** Most recent successful crawl across sources — the freshness heartbeat. */
export async function lastChecked(db: D1): Promise<number | null> {
  const row = await db
    .prepare("SELECT MAX(last_crawled_at) AS at FROM crawl_state")
    .first<{ at: number | null }>();
  return row?.at ?? null;
}
