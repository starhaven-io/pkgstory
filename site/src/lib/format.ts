// Pure helpers + shared types. No node:sqlite — safe to import from the layout,
// components, and on-demand (worker-rendered) pages.

export interface VersionEvent {
  version: string;
  revision: number;
  introducedAt: number;
  commitSha: string | null;
  subject: string;
}

export interface ContributorSummary {
  displayName: string;
  githubLogin: string | null;
  isBot: boolean;
  touchCount: number;
  versionCount: number;
  firstAt: number;
  lastAt: number;
}

// Lifecycle state of a package. The compact code travels in the KV catalog + home
// blobs; the package page reads the raw columns and derives state with lifecycleState
// — against today, so a future-scheduled stanza counts only once due.
export type StatusCode = 'n' | 'm' | 'r' | 'x' | 'd';
export type LifecycleState = 'renamed' | 'migrated' | 'removed' | 'disabled' | 'deprecated' | 'active';

export const STATUS_LABEL: Record<StatusCode, string> = {
  n: 'renamed',
  m: 'migrated',
  r: 'removed',
  x: 'disabled',
  d: 'deprecated',
};
const STATE_CODE: Record<Exclude<LifecycleState, 'active'>, StatusCode> = {
  renamed: 'n',
  migrated: 'm',
  removed: 'r',
  disabled: 'x',
  deprecated: 'd',
};

/** Per-package lifecycle metadata for the detail page (raw D1 columns). */
export interface PackageMeta {
  // Denormalized current version. After a downgrade this is the shipping version,
  // while events[0] (max introduced_at) still points at the rolled-back one —
  // re-introduced versions keep their original introduced_at by design.
  latestVersion: string | null;
  latestRevision: number;
  latestAt: number | null;
  eventCount: number;
  firstIntroducedAt: number | null;
  removedAt: number | null;
  removedCommit: string | null;
  renamedTo: string | null;
  migratedTo: string | null;
  deprecateDate: string | null;
  deprecateReason: string | null;
  disableDate: string | null;
  disableReason: string | null;
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// A deprecate!/disable! stanza is in effect only once its date has passed (a future
// date is a scheduled announcement, not yet applied — mirrors brew's own behaviour).
function inEffect(date: string | null, reason: string | null, today: string): boolean {
  const present = date != null || reason != null;
  return present && (date == null || date <= today);
}

export function lifecycleState(m: PackageMeta, today: string): LifecycleState {
  if (m.removedAt != null) {
    if (m.renamedTo != null) return 'renamed';
    if (m.migratedTo != null) return 'migrated';
    return 'removed';
  }
  if (inEffect(m.disableDate, m.disableReason, today)) return 'disabled';
  if (inEffect(m.deprecateDate, m.deprecateReason, today)) return 'deprecated';
  return 'active';
}

export function statusOf(m: PackageMeta, today: string): StatusCode | null {
  const state = lifecycleState(m, today);
  return state === 'active' ? null : STATE_CODE[state];
}

/** A date one year on, "YYYY-MM-DD" — the ~1-year cadence brew uses between stages. */
export function plusYear(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC((y ?? 0) + 1, (m ?? 1) - 1, d ?? 1)).toISOString().slice(0, 10);
}

/** A recent-updates row on the home page (from the precomputed KV `home` blob). */
export interface RecentChange {
  source: string;
  name: string;
  version: string;
  revision: number;
  introducedAt: number;
  x?: StatusCode; // lifecycle marker (absent = active)
}

/** A home-page history spotlight from the precomputed KV `home` blob. */
export interface SpotlightPackage {
  source: string;
  name: string;
  version: string | null;
  revision: number;
  title: string;
  stat: string;
  note: string;
  context: string;
  x?: StatusCode; // lifecycle marker (absent = active)
}

const SOURCE_LABELS = {
  'homebrew-formula': 'formula',
  'homebrew-cask': 'cask',
} as const;

export type KnownSource = keyof typeof SOURCE_LABELS;

/** Every source the crawl is expected to keep fresh (drives the health probe). */
export const KNOWN_SOURCES = Object.keys(SOURCE_LABELS) as KnownSource[];

export function isKnownSource(source: string): source is KnownSource {
  return Object.hasOwn(SOURCE_LABELS, source);
}

export interface SourceHealth {
  checkedAt: number | null;
  ageSeconds: number | null;
  stale: boolean;
}

export interface HealthReport {
  // Worst case across expected sources: the oldest heartbeat, null when any
  // source has none. Never the freshest — that would hide a failing source.
  checkedAt: number | null;
  ageSeconds: number | null;
  stale: boolean;
  sources: Record<string, SourceHealth>;
}

/** Pure aggregation for /health.json: stale if ANY expected source is missing or old. */
export function healthReport(
  expected: readonly string[],
  checkedBySource: ReadonlyMap<string, number>,
  now: number,
  staleAfterSeconds: number,
): HealthReport {
  const sources: Record<string, SourceHealth> = {};
  let stale = expected.length === 0; // no expected sources is a misconfiguration, not health
  let anyMissing = false;
  let oldest: number | null = null;

  for (const source of expected) {
    const at = checkedBySource.get(source);
    if (at == null) {
      sources[source] = { checkedAt: null, ageSeconds: null, stale: true };
      anyMissing = true;
      stale = true;
      continue;
    }
    const ageSeconds = Math.max(0, now - at);
    const sourceStale = ageSeconds > staleAfterSeconds;
    sources[source] = { checkedAt: at, ageSeconds, stale: sourceStale };
    if (sourceStale) stale = true;
    oldest = oldest == null ? at : Math.min(oldest, at);
  }

  const checkedAt = anyMissing ? null : oldest;
  return {
    checkedAt,
    ageSeconds: checkedAt == null ? null : Math.max(0, now - checkedAt),
    stale,
    sources,
  };
}

export function sourceLabel(source: string): string {
  return isKnownSource(source) ? SOURCE_LABELS[source] : source;
}

export function displayVersion(version: string, revision: number): string {
  return revision ? `${version}_${revision}` : version;
}

export function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Split a version into its meaningful base and de-emphasizable trailing metadata. */
export function versionParts(version: string, revision: number): { base: string; meta: string } {
  const comma = version.indexOf(',');
  const base = comma === -1 ? version : version.slice(0, comma);
  const build = comma === -1 ? '' : version.slice(comma); // cask build, e.g. ",196648"
  const rev = revision ? `_${revision}` : '';
  return { base, meta: `${build}${rev}` };
}

export function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function isoDateTime(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}
