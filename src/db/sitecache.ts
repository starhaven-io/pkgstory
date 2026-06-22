import { type D1Mode, d1Select, ensureD1PackageColumns, kvPut } from "./d1remote.ts";

// Precompute the catalog-wide payloads the site would otherwise derive with an
// expensive per-request scan, and stash them in KV. Reads on the hot paths
// (home page, search index) then cost a single KV lookup — traffic-independent,
// so no amount of traffic can run up D1. Rebuilt at the end of every crawl.

// Compact lifecycle marker: n=renamed, m=migrated, r=removed, x=disabled,
// d=deprecated; omitted when active.
type StatusCode = "n" | "m" | "r" | "x" | "d";

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

interface CatalogEntry {
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

interface HomePayload {
  formulae: number;
  casks: number;
  recent: RecentItem[];
  checkedAt: number | null;
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

  return { formulae, casks, recent, checkedAt };
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
