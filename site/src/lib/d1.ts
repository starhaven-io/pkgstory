import { env } from 'cloudflare:workers';
import type { BottleEvent, BottleInterval, ContributorSummary, PackageMeta, VersionEvent } from './format.ts';

export const TIMELINE_LIMIT = 500;
export const BOTTLE_HISTORY_LIMIT = 100;

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
  limit = TIMELINE_LIMIT,
  offset = 0,
): Promise<VersionEvent[]> {
  // OFFSET rather than a keyset cursor: reseeds renumber version_events ids, so
  // a shared cursor URL would rot. idx_events_pkg_time keeps the skip cheap.
  const { results } = await db
    .prepare(
      `SELECT ve.version, ve.revision, ve.introduced_at AS introducedAt, ve.commit_sha AS commitSha, ve.subject
         FROM version_events ve JOIN packages p ON p.id = ve.package_id
        WHERE p.source = ? AND p.name = ?
        ORDER BY ve.introduced_at DESC, ve.id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(source, name, limit, offset)
    .all<VersionEvent>();
  return results;
}

/** Formula bottle gains and losses, newest first. */
export async function bottleHistory(
  db: D1,
  source: string,
  name: string,
  limit = BOTTLE_HISTORY_LIMIT,
  offset = 0,
): Promise<BottleEvent[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT be.bottled, be.version, be.revision, be.changed_at AS changedAt,
                be.commit_sha AS commitSha, be.subject
           FROM bottle_events be JOIN packages p ON p.id = be.package_id
          WHERE p.source = ? AND p.name = ?
          ORDER BY be.changed_at DESC, be.id DESC
          LIMIT ? OFFSET ?`,
      )
      .bind(source, name, limit, offset)
      .all<Omit<BottleEvent, 'bottled'> & { bottled: number }>();
    return results.map((event) => ({ ...event, bottled: event.bottled !== 0 }));
  } catch (error) {
    if (/no such table: bottle_events/.test(String(error))) return [];
    throw error;
  }
}

/** Per-platform bottle availability ranges, newest first. */
export async function bottleIntervals(
  db: D1,
  source: string,
  name: string,
  limit = BOTTLE_HISTORY_LIMIT,
  offset = 0,
): Promise<BottleInterval[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT bi.tag, bi.started_at AS startedAt, bi.started_commit AS startedCommit,
                bi.started_subject AS startedSubject, bi.ended_at AS endedAt,
                bi.ended_commit AS endedCommit, bi.ended_subject AS endedSubject
           FROM bottle_intervals bi JOIN packages p ON p.id = bi.package_id
          WHERE p.source = ? AND p.name = ?
          ORDER BY bi.started_at DESC, bi.id DESC
          LIMIT ? OFFSET ?`,
      )
      .bind(source, name, limit, offset)
      .all<BottleInterval>();
    return results;
  } catch (error) {
    if (/no such table: bottle_intervals/.test(String(error))) return [];
    throw error;
  }
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
  type PackageMetaRow = Omit<PackageMeta, 'latestBottled' | 'latestBottleTags'> & {
    latestBottled: number | null;
    latestBottleTags: string | null;
  };
  const select = (bottleColumns: string) =>
    db
      .prepare(
        `SELECT latest_version AS latestVersion, latest_revision AS latestRevision,
              latest_at AS latestAt, ${bottleColumns}, event_count AS eventCount,
              (SELECT MIN(introduced_at) FROM version_events ve WHERE ve.package_id = packages.id) AS firstIntroducedAt,
              removed_at AS removedAt, removed_commit AS removedCommit,
              renamed_to AS renamedTo, migrated_to AS migratedTo,
              deprecate_date AS deprecateDate, deprecate_reason AS deprecateReason,
              disable_date AS disableDate, disable_reason AS disableReason
         FROM packages WHERE source = ? AND name = ?`,
      )
      .bind(source, name)
      .first<PackageMetaRow>();
  const normalize = (row: PackageMetaRow | null): PackageMeta | null =>
    row
      ? {
          ...row,
          latestBottled: row.latestBottled == null ? null : row.latestBottled !== 0,
          latestBottleTags: row.latestBottleTags == null ? null : JSON.parse(row.latestBottleTags),
        }
      : null;
  try {
    return normalize(
      await select(
        'latest_bottled AS latestBottled, bottle_event_count AS bottleEventCount, latest_bottle_tags AS latestBottleTags, bottle_interval_count AS bottleIntervalCount',
      ),
    );
  } catch (error) {
    if (/no such column: (?:latest_bottled|bottle_event_count)/.test(String(error))) {
      return normalize(
        await select(
          'NULL AS latestBottled, 0 AS bottleEventCount, NULL AS latestBottleTags, 0 AS bottleIntervalCount',
        ),
      );
    }
    if (!/no such column: (?:latest_bottle_tags|bottle_interval_count)/.test(String(error))) throw error;
  }
  try {
    return normalize(
      await select(
        'latest_bottled AS latestBottled, bottle_event_count AS bottleEventCount, NULL AS latestBottleTags, 0 AS bottleIntervalCount',
      ),
    );
  } catch (error) {
    if (!/no such column: (?:latest_bottled|bottle_event_count)/.test(String(error))) throw error;
    return normalize(
      await select('NULL AS latestBottled, 0 AS bottleEventCount, NULL AS latestBottleTags, 0 AS bottleIntervalCount'),
    );
  }
}

/** Most recent successful crawl across sources — the "last checked" display. */
export async function lastChecked(db: D1): Promise<number | null> {
  const row = await db.prepare('SELECT MAX(last_crawled_at) AS at FROM crawl_state').first<{ at: number | null }>();
  return row?.at ?? null;
}

/**
 * Per-source crawl heartbeats. The health probe cannot use the max: a
 * permanently failing cask crawl stays invisible behind a fresh formula one.
 */
export async function lastCheckedBySource(db: D1): Promise<Map<string, number>> {
  const { results } = await db
    .prepare('SELECT source, last_crawled_at AS at FROM crawl_state')
    .all<{ source: string; at: number }>();
  return new Map(results.map((row) => [row.source, Number(row.at)]));
}
