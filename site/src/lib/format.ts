// Pure helpers + shared types. No node:sqlite — safe to import from the layout,
// components, and on-demand (worker-rendered) pages.

export interface VersionEvent {
  version: string;
  revision: number;
  introducedAt: number;
  commitSha: string | null;
  subject: string;
}

export interface BottleEvent {
  bottled: boolean;
  version: string | null;
  revision: number;
  changedAt: number;
  commitSha: string | null;
  subject: string;
}

export interface BottleInterval {
  tag: string;
  startedAt: number;
  startedCommit: string;
  startedSubject: string | null;
  startedVersion: string | null;
  startedRevision: number;
  endedAt: number | null;
  endedCommit: string | null;
  endedSubject: string | null;
  endedVersion: string | null;
  endedRevision: number | null;
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
  latestBottled: boolean | null;
  latestBottleTags: string[] | null;
  eventCount: number;
  bottleEventCount: number;
  bottleIntervalCount: number;
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

function bottleOsName(tag: string): string {
  return tag
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const MAC_OS_X_VERSIONS = new Map([
  ['cheetah', '10.0'],
  ['puma', '10.1'],
  ['jaguar', '10.2'],
  ['panther', '10.3'],
  ['tiger', '10.4'],
  ['leopard', '10.5'],
  ['snow_leopard', '10.6'],
  ['lion', '10.7'],
]);
const BOTTLE_OS_ALIASES = new Map([
  ['mountainlion', 'mountain_lion'],
  ['snowleopard', 'snow_leopard'],
]);
const OS_X_VERSIONS = new Map([
  ['mountain_lion', '10.8'],
  ['mavericks', '10.9'],
  ['yosemite', '10.10'],
  ['el_capitan', '10.11'],
]);
const MACOS_VERSIONS = new Map([
  ['sierra', '10.12'],
  ['high_sierra', '10.13'],
  ['mojave', '10.14'],
  ['catalina', '10.15'],
  ['big_sur', '11'],
  ['monterey', '12'],
  ['ventura', '13'],
  ['sonoma', '14'],
  ['sequoia', '15'],
  ['tahoe', '26'],
  ['golden_gate', '27'],
]);
const BOTTLE_OS_RELEASE_ORDER = new Map(
  [...MAC_OS_X_VERSIONS.keys(), ...OS_X_VERSIONS.keys(), ...MACOS_VERSIONS.keys()].map((tag, index) => [tag, index]),
);
const BOTTLE_RANGE_SUFFIX = '_or_later';

function canonicalBottleOsTag(tag: string): string {
  const osTag = tag.startsWith('arm64_') ? tag.slice(6) : tag.startsWith('x86_64_') ? tag.slice(7) : tag;
  const releaseTag = osTag.endsWith(BOTTLE_RANGE_SUFFIX) ? osTag.slice(0, -BOTTLE_RANGE_SUFFIX.length) : osTag;
  return BOTTLE_OS_ALIASES.get(releaseTag) ?? releaseTag;
}

function bottleOperatingSystemLabel(tag: string): string {
  const orLater = tag.endsWith(BOTTLE_RANGE_SUFFIX);
  const suffix = orLater ? ' or later' : '';
  const canonicalTag = canonicalBottleOsTag(tag);
  if (canonicalTag === 'linux') return `Linux${suffix}`;
  const macOsXVersion = MAC_OS_X_VERSIONS.get(canonicalTag);
  if (macOsXVersion) return `Mac OS X ${macOsXVersion}${suffix}`;
  const name = bottleOsName(canonicalTag);
  const osXVersion = OS_X_VERSIONS.get(canonicalTag);
  if (osXVersion) return `OS X ${name} ${osXVersion}${suffix}`;
  const macosVersion = MACOS_VERSIONS.get(canonicalTag);
  return `macOS ${name}${macosVersion ? ` ${macosVersion}` : ''}${suffix}`;
}

export function bottleTagLabel(tag: string): string {
  if (tag === 'legacy') return 'Platform unspecified';
  if (tag === 'all') return 'All platforms';
  const arm64 = tag.startsWith('arm64_');
  const x86_64 = tag.startsWith('x86_64_');
  const osTag = arm64 ? tag.slice(6) : x86_64 ? tag.slice(7) : tag;
  return `${bottleOperatingSystemLabel(osTag)} (${arm64 ? 'arm64' : 'x86_64'})`;
}

function bottlePlatformOrder(tag: string): number {
  const osTag = canonicalBottleOsTag(tag);
  if (osTag === 'all') return 10_003;
  if (osTag === 'linux') return 10_002;
  if (osTag === 'legacy') return 10_001;
  return BOTTLE_OS_RELEASE_ORDER.get(osTag) ?? 10_000;
}

function compareBottlePlatforms(a: BottleInterval, b: BottleInterval): number {
  const releaseOrder = bottlePlatformOrder(b.tag) - bottlePlatformOrder(a.tag);
  if (releaseOrder) return releaseOrder;
  const labelOrder = bottleTagLabel(a.tag).localeCompare(bottleTagLabel(b.tag));
  if (labelOrder) return labelOrder;
  return b.startedAt - a.startedAt || a.tag.localeCompare(b.tag);
}

const MAX_BOTTLE_JOB_GAP_SECONDS = 7 * 24 * 60 * 60;

/** Fold staggered bottle jobs for one formula release into a support span. */
export function coalesceBottleIntervals(intervals: BottleInterval[]): BottleInterval[] {
  const ordered = [...intervals].sort((a, b) => a.tag.localeCompare(b.tag) || a.startedAt - b.startedAt);
  const spans: BottleInterval[] = [];
  for (const interval of ordered) {
    const previous = spans.at(-1);
    const sameRelease =
      previous?.tag === interval.tag &&
      previous.endedAt !== null &&
      previous.endedAt <= interval.startedAt &&
      interval.startedAt - previous.endedAt <= MAX_BOTTLE_JOB_GAP_SECONDS &&
      previous.endedVersion !== null &&
      interval.startedVersion !== null &&
      previous.endedVersion === interval.startedVersion &&
      previous.endedRevision === interval.startedRevision;
    if (!sameRelease || !previous) {
      spans.push({ ...interval });
      continue;
    }
    spans[spans.length - 1] = {
      ...previous,
      endedAt: interval.endedAt,
      endedCommit: interval.endedCommit,
      endedSubject: interval.endedSubject,
      endedVersion: interval.endedVersion,
      endedRevision: interval.endedRevision,
    };
  }
  return spans.sort(compareBottlePlatforms);
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
