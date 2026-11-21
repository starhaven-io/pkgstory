import { versionFromUrl } from "./homebrew-version.ts";
import { continuedStatement } from "./ruby.ts";

export { versionFromUrl };

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
// Indentation before these keywords is any whitespace except a line terminator, never
// \s: in multiline mode \s spans newlines, so every line start of a blank run would
// rescan the whole run.
const OLD_VERSION_STANZA = /^[^\S\r\n\u2028\u2029]*@version\s*=\s*(["'])(.*?)\1/m;
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
const OLD_URL_LINE = /^[^\S\r\n\u2028\u2029]*@url\s*=\s*(["'])(.*?)\1/m;
const TAG_OPT = /(?:\btag:|:tag\s*=>)\s*(["'])([^"']+)\1/;

/**
 * Lean extraction: explicit `version` stanza → git `tag:` → version mined from the
 * `url`. Ground-truth dependency/bottle diffing is the rich phase (operates on the
 * same blobs this reads, so it needs no re-crawl).
 */
export function parseFormula(src: string, name?: string): ParsedFormula {
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

  // Some old files declare an untagged helper formula ahead of the package's
  // tagged stable source. Retain the usual URL order when no package tag exists.
  const named = name && TAG_OPT.test(body) ? namedFormulaBody(body, name) : null;
  const own = named ? versionFromFormulaUrl(named, stableBody(named)) : null;
  const inferred = own?.tagged ? own : versionFromFormulaUrl(body, stable);
  if (inferred)
    return { version: inferred.version, revision, versionSrc: "url", bottled, bottleTags };

  const oldUrl = body.match(OLD_URL_LINE);
  if (oldUrl?.[2]) {
    const v = versionFromUrl(oldUrl[2]);
    if (v) return { version: v, revision, versionSrc: "url", bottled, bottleTags };
  }

  return { version: null, revision, versionSrc: "none", bottled, bottleTags };
}

function versionFromFormulaUrl(body: string, stable: string | null) {
  const modernUrls: Array<{ source: string; match: RegExpMatchArray | null }> = [
    { source: body, match: body.match(URL_LINE) },
  ];
  if (stable) modernUrls.push({ source: stable, match: stable.match(STABLE_URL_LINE) });
  for (const candidate of modernUrls) {
    const url = candidate.match;
    if (!url?.[2]) continue;
    const tag = continuedStatement(candidate.source, url.index ?? 0).match(TAG_OPT);
    const version = versionFromUrl(url[2], tag?.[2]);
    if (version) return { version, tagged: !!tag };
  }
  return null;
}

function beforeDataSection(src: string): string {
  const marker = src.search(/^__END__\s*$/m);
  return marker === -1 ? src : src.slice(0, marker);
}

function namedFormulaBody(src: string, name: string): string | null {
  const classes = [...src.matchAll(/^class[ \t]+([A-Z]\w*)\b/gm)];
  if (classes.length < 2) return null;
  // Formulary.class_s derives the package class from its filename. Older files
  // sometimes define a helper formula with its own URL before the package.
  const expected = name
    .toLowerCase()
    .replace(/^[a-z]/, (letter) => letter.toUpperCase())
    .replace(/[-_.\s]([a-z0-9])/gi, (_, letter: string) => letter.toUpperCase())
    .replaceAll("+", "x")
    .replace(/(.)@(\d)/, "$1AT$2");
  const target = classes.find((match) => match[1] === expected);
  if (!target) return null;
  const body = src.slice(target.index);
  const end = body.search(/^end\b/m);
  return end === -1 ? body : body.slice(0, end);
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
