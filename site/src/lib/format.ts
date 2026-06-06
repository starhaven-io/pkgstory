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
// home blobs; the package page reads the raw columns and derives it with statusOf.
export type StatusCode = "r" | "x" | "d";

export const STATUS_LABEL: Record<StatusCode, string> = {
  r: "removed",
  x: "disabled",
  d: "deprecated",
};

export function statusOf(
  removedAt: number | null,
  lifecycle: string | null,
): StatusCode | null {
  if (removedAt != null) return "r";
  if (lifecycle === "disabled") return "x";
  if (lifecycle === "deprecated") return "d";
  return null;
}

/** Per-package lifecycle metadata for the detail page (raw D1 columns). */
export interface PackageMeta {
  removedAt: number | null;
  removedCommit: string | null;
  lifecycle: string | null;
  lifecycleDate: string | null;
  lifecycleReason: string | null;
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
