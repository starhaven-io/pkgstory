export type VersionSource = "version-stanza" | "url" | "subject" | "none";

export interface ParsedFormula {
  version: string | null;
  revision: number;
  versionSrc: VersionSource;
  bottled: boolean;
  bottleTags: string[];
}

// Modern metadata is normally top-level. Historical `stable do` blocks indent the
// same metadata one level further, so those are parsed as an explicit region below.
// Quote-agnostic: 2009-era formulae wrote `version '1.0'` with single quotes.
const VERSION_STANZA = /^ {2}version\s+(["'])([^"']+)\1/m;
const STABLE_VERSION_STANZA = /^ {4}version\s+(["'])([^"']+)\1/m;
const OLD_VERSION_STANZA = /^\s*@version\s*=\s*(["'])(.*?)\1/m;
const REVISION = /^ {2}revision\s+([^\s#]+)/m;
const STABLE_REVISION = /^ {4}revision\s+([^\s#]+)/m;
// A bottle block records an actual built artifact. Historical `bottle :unneeded`
// and `bottle :disable` modifiers do not, so deliberately exclude them.
const BOTTLE_BLOCK = /^ {2}bottle\s+do\s*(?:#.*)?$/m;
const LEGACY_BOTTLE = /^ {2}bottle\s+["']/m;
// Modern formula URLs are top-level only; nested resource URLs are dependency
// archives, not package versions. The old @url form lived inside initialize.
const URL_LINE = /^ {2}url\s+(["'])(.*?)\1/m;
const STABLE_URL_LINE = /^ {4}url\s+(["'])(.*?)\1/m;
const OLD_URL_LINE = /^\s*@url\s*=\s*(["'])(.*?)\1/m;
const TAG_OPT = /\btag:\s*(["'])([^"']+)\1/;
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
  const body = beforeDataSection(src);
  const stable = stableBody(body);
  const revMatch = body.match(REVISION) ?? stable?.match(STABLE_REVISION);
  const revision = parseRevision(revMatch?.[1]);
  const bottleTags = parseBottleTags(body);
  const bottled = bottleTags.length > 0;

  const stanza = body.match(VERSION_STANZA) ?? stable?.match(STABLE_VERSION_STANZA);
  if (stanza?.[2])
    return { version: stanza[2], revision, versionSrc: "version-stanza", bottled, bottleTags };

  const oldStanza = body.match(OLD_VERSION_STANZA);
  if (oldStanza?.[2])
    return { version: oldStanza[2], revision, versionSrc: "version-stanza", bottled, bottleTags };

  const modernUrls: Array<{ source: string; match: RegExpMatchArray | null }> = [
    { source: body, match: body.match(URL_LINE) },
  ];
  if (stable) modernUrls.push({ source: stable, match: stable.match(STABLE_URL_LINE) });
  for (const candidate of modernUrls) {
    const url = candidate.match;
    if (!url?.[2]) continue;
    const tag = urlStanza(candidate.source, url.index ?? 0).match(TAG_OPT);
    if (tag?.[2]) {
      const v = cleanVersion(tag[2]);
      if (v) return { version: v, revision, versionSrc: "url", bottled, bottleTags };
    }
    const v = versionFromUrl(url[2]);
    if (v) return { version: v, revision, versionSrc: "url", bottled, bottleTags };
  }

  const oldUrl = body.match(OLD_URL_LINE);
  if (oldUrl?.[2]) {
    const v = versionFromUrl(oldUrl[2]);
    if (v) return { version: v, revision, versionSrc: "url", bottled, bottleTags };
  }

  return { version: null, revision, versionSrc: "none", bottled, bottleTags };
}

function beforeDataSection(src: string): string {
  const marker = src.search(/^__END__\s*$/m);
  return marker === -1 ? src : src.slice(0, marker);
}

// `stable do` is a package metadata region, unlike resource/livecheck/on_* blocks.
// Its closing `end` is the next one at formula-level indentation.
function stableBody(src: string): string | null {
  const start = src.match(/^ {2}stable\s+do\s*(?:#.*)?$/m);
  if (!start || start.index === undefined) return null;
  const rest = src.slice(start.index + start[0].length);
  const end = rest.search(/^ {2}end\b/m);
  return end === -1 ? rest : rest.slice(0, end);
}

function parseRevision(raw: string | undefined): number {
  if (raw === undefined) return 0;
  if (!/^\d(?:_?\d)*$/.test(raw)) {
    throw new RangeError(`unsupported formula revision: ${raw}`);
  }
  const compact = raw.replaceAll("_", "");
  const octal = compact.length > 1 && compact.startsWith("0");
  if (octal && !/^[0-7]+$/.test(compact)) {
    throw new RangeError(`unsupported formula revision: ${raw}`);
  }
  const digits = compact.replace(/^0+(?=\d)/, "");
  const maxDigits = octal ? 18 : String(Number.MAX_SAFE_INTEGER).length;
  if (digits.length > maxDigits) {
    throw new RangeError(`formula revision is outside JavaScript's safe integer range: ${raw}`);
  }
  const exact = BigInt(octal ? `0o${digits}` : digits);
  if (exact > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`formula revision is outside JavaScript's safe integer range: ${raw}`);
  }
  return Number(exact);
}

// A git URL's tag may be on the same line or on continuation lines. Ruby permits
// unusual alignment here, so follow the comma chain rather than trusting indent.
function urlStanza(src: string, start: number): string {
  const lines = src.slice(start).split("\n");
  const stanza = [lines[0] ?? ""];
  let continuation = stanza[0]?.trimEnd().endsWith(",") ?? false;
  for (const line of lines.slice(1)) {
    if (!continuation) break;
    stanza.push(line);
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    continuation = line.trimEnd().endsWith(",");
  }
  return stanza.join("\n");
}

export function parseBottleTags(src: string): string[] {
  const start = src.match(BOTTLE_BLOCK);
  if (!start || start.index === undefined) return LEGACY_BOTTLE.test(src) ? ["legacy"] : [];

  const rest = src.slice(start.index + start[0].length);
  const end = rest.search(/^ {2}end\b/m);
  const body = end === -1 ? rest : rest.slice(0, end);
  const tags = new Set<string>();
  let hasChecksum = false;
  for (const line of body.split("\n")) {
    if (!/^\s+(?:sha1|sha256)\b/.test(line)) continue;
    hasChecksum = true;
    for (const match of line.matchAll(/\b([a-z0-9_]+):\s*["'][^"']+["']/gi)) {
      const tag = match[1]?.toLowerCase();
      if (tag && tag !== "cellar") tags.add(tag);
    }
    const legacy = line.match(/=>\s*:([a-z0-9_]+)\b/i)?.[1];
    if (legacy) tags.add(legacy.toLowerCase());
  }
  return tags.size ? [...tags].sort() : hasChecksum ? ["legacy"] : [];
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
