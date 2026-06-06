// Pure helpers + shared types. No node:sqlite — safe to import from the layout,
// components, and on-demand (worker-rendered) pages.

export interface VersionEvent {
  version: string;
  revision: number;
  introducedAt: number;
  commitSha: string | null;
  subject: string;
}

// Lifecycle state of a package. The compact code (r/x/d) travels in the KV catalog +
// home blobs; the package page reads the raw stanza columns and derives state with
// lifecycleState — against today, so a future-scheduled stanza counts only once due.
export type StatusCode = "r" | "x" | "d";
export type LifecycleState = "removed" | "disabled" | "deprecated" | "active";

export const STATUS_LABEL: Record<StatusCode, string> = {
  r: "removed",
  x: "disabled",
  d: "deprecated",
};
const STATE_CODE: Record<Exclude<LifecycleState, "active">, StatusCode> = {
  removed: "r",
  disabled: "x",
  deprecated: "d",
};

/** Per-package lifecycle metadata for the detail page (raw D1 columns). */
export interface PackageMeta {
  removedAt: number | null;
  removedCommit: string | null;
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
function inEffect(
  date: string | null,
  reason: string | null,
  today: string,
): boolean {
  const present = date != null || reason != null;
  return present && (date == null || date <= today);
}

export function lifecycleState(m: PackageMeta, today: string): LifecycleState {
  if (m.removedAt != null) return "removed";
  if (inEffect(m.disableDate, m.disableReason, today)) return "disabled";
  if (inEffect(m.deprecateDate, m.deprecateReason, today)) return "deprecated";
  return "active";
}

export function statusOf(m: PackageMeta, today: string): StatusCode | null {
  const state = lifecycleState(m, today);
  return state === "active" ? null : STATE_CODE[state];
}

/** A date one year on, "YYYY-MM-DD" — the ~1-year cadence brew uses between stages. */
export function plusYear(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC((y ?? 0) + 1, (m ?? 1) - 1, d ?? 1))
    .toISOString()
    .slice(0, 10);
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

const SOURCE_LABELS: Record<string, string> = {
  "homebrew-formula": "formula",
  "homebrew-cask": "cask",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export function displayVersion(version: string, revision: number): string {
  return revision ? `${version}_${revision}` : version;
}

/** Split a version into its meaningful base and de-emphasizable trailing metadata. */
export function versionParts(
  version: string,
  revision: number,
): { base: string; meta: string } {
  const comma = version.indexOf(",");
  const base = comma === -1 ? version : version.slice(0, comma);
  const build = comma === -1 ? "" : version.slice(comma); // cask build, e.g. ",196648"
  const rev = revision ? `_${revision}` : "";
  return { base, meta: `${build}${rev}` };
}

export function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function isoDateTime(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}
