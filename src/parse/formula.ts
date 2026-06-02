export type VersionSource = "version-stanza" | "url" | "subject" | "none";

export interface ParsedFormula {
  version: string | null;
  revision: number;
  versionSrc: VersionSource;
}

// Anchored to 2-space (top-level) indentation: Homebrew style guarantees it, and it
// avoids matching a nested `version`/`revision` inside a resource or on_os block.
const VERSION_STANZA = /^ {2}version\s+"([^"]+)"/m;
const REVISION = /^ {2}revision\s+(\d+)/m;
const URL_LINE = /^\s*url\s+"([^"]+)"/m;
const TAG_OPT = /\btag:\s*"([^"]+)"/;
const SEMVERISH = /(\d+(?:\.\d+)+(?:[._-][0-9A-Za-z.]+)?)/;

/**
 * Lean extraction: explicit `version` stanza → git `tag:` → version mined from the
 * `url`. Ground-truth dependency/bottle diffing is the rich phase (operates on the
 * same blobs this reads, so it needs no re-crawl).
 */
export function parseFormula(src: string): ParsedFormula {
  const revMatch = src.match(REVISION);
  const revision = revMatch?.[1] ? Number(revMatch[1]) : 0;

  const stanza = src.match(VERSION_STANZA);
  if (stanza?.[1]) return { version: stanza[1], revision, versionSrc: "version-stanza" };

  const tag = src.match(TAG_OPT);
  if (tag?.[1]) {
    const v = cleanVersion(tag[1]);
    if (v) return { version: v, revision, versionSrc: "url" };
  }

  const url = src.match(URL_LINE);
  if (url?.[1]) {
    const v = versionFromUrl(url[1]);
    if (v) return { version: v, revision, versionSrc: "url" };
  }

  return { version: null, revision, versionSrc: "none" };
}

export function versionFromUrl(url: string): string | null {
  // GitHub-style tag directories give the cleanest signal.
  for (const re of [
    /\/archive\/refs\/tags\/v?([0-9][^/"]*?)(?:\.tar\.(?:gz|xz|bz2)|\.tgz|\.zip)?$/,
    /\/releases\/download\/v?([0-9][^/]+?)\//,
  ]) {
    const m = url.match(re);
    if (m?.[1]) {
      const v = cleanVersion(m[1]);
      if (v) return v;
    }
  }

  // Otherwise mine the filename — the last path segment (which also captures the
  // tarball inside mirror queries like closer.lua?path=…/foo-23.tar.gz), minus any
  // query/fragment and archive/packaging suffixes.
  const file = (url.split("/").pop() ?? "").split(/[?#]/)[0] ?? "";
  const stem = file
    .replace(/\.(?:tar\.(?:gz|xz|bz2|zst)|tgz|tbz2?|txz|tar|zip|gz|xz|bz2)$/i, "")
    .replace(/\.orig$/i, "");

  // A dotted version anywhere wins (git-2.54.0, jq-1.7.1).
  const dotted = stem.match(SEMVERISH);
  if (dotted?.[1]) return cleanVersion(dotted[1]);

  // Else a trailing numeric token: bare integer (bsdmake-24, crm114_20100106) or
  // underscore-encoded (CLENS_0_7_0 → 0.7.0).
  const tail = stem.match(/[-_]v?((?:\d+_)*\d+)$/);
  if (tail?.[1]) return tail[1].replace(/_/g, ".");

  return null;
}

function cleanVersion(raw: string): string | null {
  const v = raw
    .replace(/^v/, "")
    .replace(/\.(?:tar\.gz|tar\.xz|tar\.bz2|tgz|tar|zip)$/, "")
    .trim();
  return v.length ? v : null;
}
