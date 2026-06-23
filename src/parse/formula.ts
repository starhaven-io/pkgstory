export type VersionSource = "version-stanza" | "url" | "subject" | "none";

export interface ParsedFormula {
  version: string | null;
  revision: number;
  versionSrc: VersionSource;
}

// Anchored to 2-space (top-level) indentation: Homebrew style guarantees it, and it
// avoids matching a nested `version`/`revision` inside a resource or on_os block.
// Quote-agnostic: 2009-era formulae wrote `version '1.0'` with single quotes.
const VERSION_STANZA = /^ {2}version\s+(["'])([^"']+)\1/m;
const OLD_VERSION_STANZA = /^\s*@version\s*=\s*(["'])(.*?)\1/m;
const REVISION = /^ {2}revision\s+(\d+)/m;
// Modern formula URLs are top-level only; nested resource URLs are dependency
// archives, not package versions. The old @url form lived inside initialize.
const URL_LINES = [/^ {2}url\s+(["'])(.*?)\1/m, /^\s*@url\s*=\s*(["'])(.*?)\1/m];
const TAG_OPT = /\btag:\s*"([^"]+)"/;
const SEMVERISH = /(\d+(?:\.\d+)+(?:[._-][0-9A-Za-z.]+)?)/;
// Build/artifact/platform labels that ride along in a download filename
// (apache-activemq-6.2.6-bin, ack-2.24-single-file, racket-8.0-src, ispc-1.9.2-osx)
// but aren't the version. Upstream release-stage qualifiers (-stable, -rc, -beta,
// -RELEASE) are deliberately absent — those distinguish real versions.
const PACKAGING_LABEL = /[-_.](?:src|source|bin|single|osx|macos|darwin|linux)$/i;

/**
 * Lean extraction: explicit `version` stanza → git `tag:` → version mined from the
 * `url`. Ground-truth dependency/bottle diffing is the rich phase (operates on the
 * same blobs this reads, so it needs no re-crawl).
 */
export function parseFormula(src: string): ParsedFormula {
  const revMatch = src.match(REVISION);
  const revision = revMatch?.[1] ? Number(revMatch[1]) : 0;

  const stanza = src.match(VERSION_STANZA);
  if (stanza?.[2]) return { version: stanza[2], revision, versionSrc: "version-stanza" };

  const oldStanza = src.match(OLD_VERSION_STANZA);
  if (oldStanza?.[2]) return { version: oldStanza[2], revision, versionSrc: "version-stanza" };

  const tag = src.match(TAG_OPT);
  if (tag?.[1]) {
    const v = cleanVersion(tag[1]);
    if (v) return { version: v, revision, versionSrc: "url" };
  }

  for (const re of URL_LINES) {
    const url = src.match(re);
    if (url?.[2]) {
      const v = versionFromUrl(url[2]);
      if (v) return { version: v, revision, versionSrc: "url" };
    }
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

  // A dotted version anywhere wins (git-2.54.0, jq-1.7.1), minus any trailing
  // build/artifact label SEMVERISH swept in (6.2.6-bin, 8.0-src, 2.24-single).
  const dotted = stem.match(SEMVERISH);
  if (dotted?.[1]) return cleanVersion(dotted[1].replace(PACKAGING_LABEL, ""));

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
