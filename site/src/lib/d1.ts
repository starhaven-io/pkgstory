import { env } from 'cloudflare:workers';
import type { ContributorSummary, PackageMeta, VersionEvent } from './format.ts';

export const TIMELINE_LIMIT = 500;

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

export async function timeline(db: D1, source: string, name: string, limit = TIMELINE_LIMIT): Promise<VersionEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT ve.version, ve.revision, ve.introduced_at AS introducedAt, ve.commit_sha AS commitSha, ve.subject
         FROM version_events ve JOIN packages p ON p.id = ve.package_id
        WHERE p.source = ? AND p.name = ?
        ORDER BY ve.introduced_at DESC, ve.id DESC
        LIMIT ?`,
    )
    .bind(source, name, limit)
    .all<VersionEvent>();
  return results;
}

/** Authors and co-authors of every commit touching one package's file. */
export async function contributors(db: D1, source: string, name: string): Promise<ContributorSummary[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT c.display_name AS displayName, c.github_login AS githubLogin,
              c.is_bot != 0 AS isBot,
              SUM(pcs.touch_count) AS touchCount,
              SUM(pcs.version_count) AS versionCount,
              MIN(pcs.first_at) AS firstAt,
              MAX(pcs.last_at) AS lastAt
         FROM package_contribution_slices pcs
         JOIN contributors c ON c.contributor_key = pcs.contributor_key
         JOIN packages p ON p.id = pcs.package_id
         JOIN contributor_seeds cs ON cs.source = p.source
        WHERE p.source = ? AND p.name = ?
        GROUP BY pcs.contributor_key, c.display_name, c.github_login, c.is_bot
        ORDER BY c.is_bot ASC, touchCount DESC, lastAt DESC, pcs.contributor_key ASC`,
      )
      .bind(source, name)
      .all<Omit<ContributorSummary, 'isBot'> & { isBot: number }>();
    return results.map((contributor) => ({ ...contributor, isBot: contributor.isBot !== 0 }));
  } catch (error) {
    // Code can deploy before the crawler creates the new read tables. Keep package
    // pages available during that migration window; other D1 failures still surface.
    if (/no such table: (?:package_contribution_slices|contributors|contributor_seeds)/.test(String(error))) return [];
    throw error;
  }
}

/** Per-package lifecycle metadata (removed / deprecated / disabled state). */
export async function packageMeta(db: D1, source: string, name: string): Promise<PackageMeta | null> {
  const row = await db
    .prepare(
      `SELECT latest_version AS latestVersion, latest_revision AS latestRevision,
              latest_at AS latestAt, event_count AS eventCount,
              (SELECT MIN(introduced_at) FROM version_events ve WHERE ve.package_id = packages.id) AS firstIntroducedAt,
              removed_at AS removedAt, removed_commit AS removedCommit,
              renamed_to AS renamedTo, migrated_to AS migratedTo,
              deprecate_date AS deprecateDate, deprecate_reason AS deprecateReason,
              disable_date AS disableDate, disable_reason AS disableReason
         FROM packages WHERE source = ? AND name = ?`,
    )
    .bind(source, name)
    .first<PackageMeta>();
  return row;
}

/** Most recent successful crawl across sources — the freshness heartbeat. */
export async function lastChecked(db: D1): Promise<number | null> {
  const row = await db.prepare('SELECT MAX(last_crawled_at) AS at FROM crawl_state').first<{ at: number | null }>();
  return row?.at ?? null;
}
