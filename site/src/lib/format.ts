// Pure helpers + shared types. No node:sqlite — safe to import from the layout,
// components, and on-demand (worker-rendered) pages.

export interface VersionEvent {
  version: string;
  revision: number;
  introducedAt: number;
  commitSha: string | null;
  subject: string;
}

/** A recent-updates row on the home page (from the precomputed KV `home` blob). */
export interface RecentChange {
  source: string;
  name: string;
  version: string;
  revision: number;
  introducedAt: number;
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
