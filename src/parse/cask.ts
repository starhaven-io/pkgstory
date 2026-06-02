export interface ParsedCask {
  version: string | null;
}

const VERSION = /^ {2}version\s+"([^"]+)"/m;
const VERSION_LATEST = /^ {2}version\s+:latest\b/m;

/** Casks almost always carry an explicit `version` stanza (e.g. "1.122.1,abcdef"). */
export function parseCask(src: string): ParsedCask {
  const m = src.match(VERSION);
  if (m?.[1]) return { version: m[1] };
  if (VERSION_LATEST.test(src)) return { version: "latest" };
  return { version: null };
}
