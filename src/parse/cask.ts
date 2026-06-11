export interface ParsedCask {
  version: string | null;
}

// 2-space is the top-level stanza; 4-space catches arch/OS-conditional versions
// inside on_arm/on_intel/on_<os> blocks (first match wins — bumps keep the arches
// on the same version, modulo the build suffix).
const VERSION = /^ {2,4}version\s+"([^"]+)"/m;
const VERSION_LATEST = /^ {2,4}version\s+:latest\b/m;

/** Casks almost always carry an explicit `version` stanza (e.g. "1.122.1,abcdef"). */
export function parseCask(src: string): ParsedCask {
  const m = src.match(VERSION);
  if (m?.[1]) return { version: m[1] };
  if (VERSION_LATEST.test(src)) return { version: "latest" };
  return { version: null };
}
