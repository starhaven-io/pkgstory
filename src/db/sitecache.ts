import { type D1Mode, d1Select, ensureD1PackageColumns, kvPut } from "./d1remote.ts";

// Precompute the catalog-wide payloads the site would otherwise derive with an
// expensive per-request scan, and stash them in KV. Reads on the hot paths
// (home page, search index) then cost a single KV lookup — traffic-independent,
// so no amount of traffic can run up D1. Rebuilt at the end of every crawl.

// Compact lifecycle marker: n=renamed, m=migrated, r=removed, x=disabled,
// d=deprecated; omitted when active.
export type StatusCode = "n" | "m" | "r" | "x" | "d";

// A deprecate!/disable! stanza is only in effect once its date has passed (a future
// date is a scheduled announcement). Recomputed every crawl, so a scheduled package
// flips to deprecated/disabled the day its date lands — no re-crawl needed.
function inEffect(date: unknown, reason: unknown, today: string): boolean {
  const present = date != null || reason != null;
  return present && (date == null || String(date) <= today);
}

function statusCode(
  removedAt: unknown,
  renamedTo: unknown,
  migratedTo: unknown,
  deprecateDate: unknown,
  deprecateReason: unknown,
  disableDate: unknown,
  disableReason: unknown,
  today: string,
): StatusCode | undefined {
  if (removedAt != null) {
    if (renamedTo != null) return "n";
    if (migratedTo != null) return "m";
    return "r";
  }
  if (inEffect(disableDate, disableReason, today)) return "x";
  if (inEffect(deprecateDate, deprecateReason, today)) return "d";
  return undefined;
}

export interface CatalogEntry {
  n: string; // name
  s: "c" | "f"; // cask | formula
  v: string | null; // latest version
  r: number; // latest revision
  c: number; // event count
  x?: StatusCode; // lifecycle marker (absent = active)
}

interface RecentItem {
  source: string;
  name: string;
  version: string;
  revision: number;
  introducedAt: number;
  x?: StatusCode; // lifecycle marker (absent = active)
}

export interface SpotlightItem {
  source: string;
  name: string;
  version: string | null;
  revision: number;
  title: string;
  stat: string; // headline figure, e.g. "1,555 events" or "15 years quiet"
  note: string; // one-sentence explanation of the stat
  context: string; // footer: a secondary fact + kind, e.g. "3 events · formula"
  x?: StatusCode; // lifecycle marker (absent = active)
}

interface HomePayload {
  formulae: number;
  casks: number;
  spotlight: SpotlightItem[];
  recent: RecentItem[];
  checkedAt: number | null;
}

function sourceId(e: CatalogEntry): string {
  return e.s === "c" ? "homebrew-cask" : "homebrew-formula";
}

function packageKey(source: string, name: string): string {
  return `${source}\x00${name}`;
}

function kindLabel(e: CatalogEntry): string {
  return e.s === "c" ? "cask" : "formula";
}

// The editorial content of one card, derived per category from a D1 row and the
// package's catalog entry.
interface StoryParts {
  title: string;
  stat: string;
  note: string;
  context: string;
}

function spotlightItem(e: CatalogEntry, parts: StoryParts): SpotlightItem {
  return {
    source: sourceId(e),
    name: e.n,
    version: e.v,
    revision: e.r,
    title: parts.title,
    stat: parts.stat,
    note: parts.note,
    context: parts.context,
    ...(e.x ? { x: e.x } : {}),
  };
}

function dateLabel(unixSeconds: unknown): string {
  return new Date(Number(unixSeconds) * 1000).toISOString().slice(0, 10);
}

export function durationLabel(seconds: number): string {
  const days = Math.max(1, Math.round(seconds / 86400));
  if (days >= 365) {
    const years = days / 365;
    return `${years >= 10 ? Math.round(years) : years.toFixed(1)} years`;
  }
  if (days >= 60) return `${Math.round(days / 30)} months`;
  return `${days} days`;
}

function numberLabel(value: unknown): string {
  return Number(value).toLocaleString("en-US");
}

/**
 * One card per category, in priority order: the first package a category nominates
 * that no earlier card already used. Categories are lazy producers, so once `limit`
 * cards are filled the later (reserve) categories are never queried — the common case
 * where the core categories fill the grid runs no extra D1 scans. A category that
 * nominates nothing (e.g. no removed package on a small dataset) is simply skipped.
 */
export function pickSpotlightStories(
  producers: Array<() => SpotlightItem[]>,
  limit = 6,
): SpotlightItem[] {
  const seen = new Set<string>();
  const stories: SpotlightItem[] = [];

  for (const produce of producers) {
    if (stories.length >= limit) break;
    for (const story of produce()) {
      const key = packageKey(story.source, story.name);
      if (seen.has(key)) continue;
      seen.add(key);
      stories.push(story);
      break;
    }
  }

  return stories;
}

interface Category {
  sql: string;
  // Build the card from a result row and the package's catalog entry; return null to
  // drop a row (e.g. a package that has since fallen out of the catalog).
  story: (row: Record<string, unknown>, entry: CatalogEntry) => StoryParts | null;
}

function runCategory(
  mode: D1Mode,
  catalogByPackage: Map<string, CatalogEntry>,
  cat: Category,
): SpotlightItem[] {
  return d1Select(mode, cat.sql).flatMap((row) => {
    const entry = catalogByPackage.get(packageKey(String(row.source), String(row.name)));
    if (!entry) return [];
    const parts = cat.story(row, entry);
    return parts ? [spotlightItem(entry, parts)] : [];
  });
}

// Six core angles plus two reserves, each a distinct "shape" of history so no two
// cards restate the same superlative. Ordered by priority; the picker stops once the
// grid is full, so the reserves only run when a core category is empty (e.g. no
// removed package in a small dataset). Recomputed every crawl into the KV `home`
// blob — the site never runs these scans at request time.
function buildSpotlight(mode: D1Mode, catalog: CatalogEntry[]): SpotlightItem[] {
  const byPkg = new Map(catalog.map((e) => [packageKey(sourceId(e), e.n), e]));
  const yearAgo = Math.floor(Date.now() / 1000) - 365 * 86400;

  const categories: Category[] = [
    {
      // Most updates — the all-time event-count leader.
      sql: `SELECT source, name
              FROM packages
             WHERE event_count > 0
             ORDER BY event_count DESC, name
             LIMIT 12`,
      story: (_row, e) => ({
        title: "Most updates",
        stat: `${numberLabel(e.c)} events`,
        note: "More version changes than any other tracked package.",
        context: kindLabel(e),
      }),
    },
    {
      // Hottest lately — recency intensity; the story is its share of lifetime events.
      sql: `SELECT p.source, p.name, COUNT(*) AS events
              FROM version_events ve JOIN packages p ON p.id = ve.package_id
             WHERE ve.introduced_at >= ${yearAgo}
             GROUP BY ve.package_id
             ORDER BY events DESC, p.name
             LIMIT 12`,
      story: (row, e) => {
        const recent = Number(row.events);
        return {
          title: "Hottest lately",
          stat: `${numberLabel(recent)} in a year`,
          note: `${numberLabel(recent)} of ${numberLabel(e.c)} lifetime updates landed in the last 365 days.`,
          context: kindLabel(e),
        };
      },
    },
    {
      // Longest pause — the biggest gap between two consecutive version events.
      sql: `WITH ordered AS (
               SELECT ve.package_id AS pid, ve.introduced_at AS at,
                      LAG(ve.introduced_at) OVER (PARTITION BY ve.package_id ORDER BY ve.introduced_at) AS prev_at
                 FROM version_events ve
             )
             SELECT p.source, p.name, ordered.at, ordered.prev_at, ordered.at - ordered.prev_at AS gap
               FROM ordered JOIN packages p ON p.id = ordered.pid
              WHERE ordered.prev_at IS NOT NULL
              ORDER BY gap DESC, p.name
              LIMIT 12`,
      story: (row, e) => ({
        title: "Longest pause",
        stat: `${durationLabel(Number(row.gap))} quiet`,
        note: `No update between ${dateLabel(row.prev_at)} and ${dateLabel(row.at)}.`,
        context: `${numberLabel(e.c)} events · ${kindLabel(e)}`,
      }),
    },
    {
      // Oldest trail — the earliest first version event in the index.
      sql: `SELECT p.source, p.name, MIN(ve.introduced_at) AS first_at
              FROM version_events ve JOIN packages p ON p.id = ve.package_id
             GROUP BY ve.package_id
             ORDER BY first_at ASC, p.name
             LIMIT 12`,
      story: (row, e) => ({
        title: "Oldest trail",
        stat: `since ${dateLabel(row.first_at)}`,
        note: "Earliest version event in the index.",
        context: `${numberLabel(e.c)} events · ${kindLabel(e)}`,
      }),
    },
    {
      // Most revisions — packaging churn; the story is the share that carried a bump.
      sql: `SELECT p.source, p.name, COUNT(*) AS revisions
              FROM version_events ve JOIN packages p ON p.id = ve.package_id
             WHERE ve.revision > 0
             GROUP BY ve.package_id
             ORDER BY revisions DESC, p.name
             LIMIT 12`,
      story: (row, e) => {
        const revs = Number(row.revisions);
        return {
          title: "Most revisions",
          stat: `${numberLabel(revs)} revisions`,
          note: `${numberLabel(revs)} of ${numberLabel(e.c)} version events carried a Homebrew revision bump.`,
          context: kindLabel(e),
        };
      },
    },
    {
      // Retired epic — a removed package, told by how long its run lasted.
      sql: `SELECT p.source, p.name, p.removed_at,
                    (SELECT MIN(introduced_at) FROM version_events WHERE package_id = p.id) AS first_at
               FROM packages p
              WHERE p.removed_at IS NOT NULL AND p.event_count > 0
              ORDER BY p.event_count DESC, p.name
              LIMIT 12`,
      story: (row, e) => {
        const removedAt = Number(row.removed_at);
        const firstAt = row.first_at == null ? removedAt : Number(row.first_at);
        return {
          title: "Retired epic",
          stat: `${durationLabel(removedAt - firstAt)} run`,
          note: `${numberLabel(e.c)} updates before it was removed on ${dateLabel(removedAt)}.`,
          context: kindLabel(e),
        };
      },
    },
    {
      // Reserve: Newest arrival — the most recent debut that already has a trail.
      sql: `SELECT p.source, p.name, MIN(ve.introduced_at) AS first_at
              FROM version_events ve JOIN packages p ON p.id = ve.package_id
             WHERE p.removed_at IS NULL
             GROUP BY ve.package_id
            HAVING COUNT(*) >= 3
             ORDER BY first_at DESC, p.name
             LIMIT 12`,
      story: (row, e) => ({
        title: "Newest arrival",
        stat: `added ${dateLabel(row.first_at)}`,
        note: "Most recent debut to already build a multi-version trail.",
        context: `${numberLabel(e.c)} events · ${kindLabel(e)}`,
      }),
    },
    {
      // Reserve: Steadiest cadence — lowest variance between updates (a metronome).
      // Gaps are in days so the variance ORDER BY stays within double precision.
      sql: `WITH gaps AS (
               SELECT ve.package_id AS pid,
                      (ve.introduced_at - LAG(ve.introduced_at) OVER (PARTITION BY ve.package_id ORDER BY ve.introduced_at)) / 86400.0 AS g
                 FROM version_events ve
             )
             SELECT p.source, p.name, AVG(gaps.g) AS mean_days
               FROM gaps JOIN packages p ON p.id = gaps.pid
              WHERE gaps.g IS NOT NULL
              GROUP BY gaps.pid
             HAVING COUNT(gaps.g) >= 8
              ORDER BY (AVG(gaps.g * gaps.g) - AVG(gaps.g) * AVG(gaps.g)) ASC, p.name
              LIMIT 12`,
      story: (row, e) => ({
        title: "Steadiest cadence",
        stat: `~${Math.max(1, Math.round(Number(row.mean_days)))}d apart`,
        note: "Most regular update rhythm in the index.",
        context: `${numberLabel(e.c)} events · ${kindLabel(e)}`,
      }),
    },
  ];

  return pickSpotlightStories(categories.map((cat) => () => runCategory(mode, byPkg, cat)));
}

/** The lean search index — one row per package with events. ~22k-row scan (no join). */
function buildCatalog(mode: D1Mode, today: string): CatalogEntry[] {
  const rows = d1Select(
    mode,
    `SELECT name AS n,
            CASE source WHEN 'homebrew-cask' THEN 'c' ELSE 'f' END AS s,
            latest_version  AS v,
            latest_revision AS r,
            event_count     AS c,
            removed_at, renamed_to, migrated_to,
            deprecate_date, deprecate_reason, disable_date, disable_reason
       FROM packages
      WHERE event_count > 0
      ORDER BY name`,
  );
  return rows.map((row) => {
    const x = statusCode(
      row.removed_at,
      row.renamed_to,
      row.migrated_to,
      row.deprecate_date,
      row.deprecate_reason,
      row.disable_date,
      row.disable_reason,
      today,
    );
    return {
      n: String(row.n),
      s: row.s === "c" ? "c" : "f",
      v: (row.v as string | null) ?? null,
      r: Number(row.r ?? 0),
      c: Number(row.c ?? 0),
      ...(x ? { x } : {}),
    };
  });
}

function buildHome(mode: D1Mode, catalog: CatalogEntry[], today: string): HomePayload {
  let formulae = 0;
  let casks = 0;
  for (const e of catalog) {
    if (e.s === "c") casks += 1;
    else formulae += 1;
  }

  const recent = d1Select(
    mode,
    `SELECT p.source, p.name, ve.version, ve.revision, ve.introduced_at AS introducedAt,
            p.removed_at, p.renamed_to, p.migrated_to,
            p.deprecate_date, p.deprecate_reason, p.disable_date, p.disable_reason
       FROM version_events ve JOIN packages p ON p.id = ve.package_id
      ORDER BY ve.introduced_at DESC, ve.id DESC
      LIMIT 25`,
  ).map((row) => {
    const x = statusCode(
      row.removed_at,
      row.renamed_to,
      row.migrated_to,
      row.deprecate_date,
      row.deprecate_reason,
      row.disable_date,
      row.disable_reason,
      today,
    );
    return {
      source: String(row.source),
      name: String(row.name),
      version: String(row.version),
      revision: Number(row.revision ?? 0),
      introducedAt: Number(row.introducedAt),
      ...(x ? { x } : {}),
    };
  });

  const checkedRow = d1Select(mode, "SELECT MAX(last_crawled_at) AS at FROM crawl_state");
  const checkedAt = checkedRow[0]?.at != null ? Number(checkedRow[0].at) : null;

  return { formulae, casks, spotlight: buildSpotlight(mode, catalog), recent, checkedAt };
}

/** Rebuild and publish the site-cache KV blobs from current D1 state. */
export function refreshSiteCache(mode: D1Mode): { packages: number } {
  ensureD1PackageColumns(mode);
  // Effective state is date-relative; stamp it once so a scheduled package's chip
  // appears the day its deprecate/disable date lands, on the next crawl.
  const today = new Date().toISOString().slice(0, 10);
  const catalog = buildCatalog(mode, today);
  const home = buildHome(mode, catalog, today);
  kvPut(mode, "catalog", JSON.stringify(catalog));
  kvPut(mode, "home", JSON.stringify(home));
  return { packages: catalog.length };
}
