const DIRECT_EMAIL = /[^\s@<>()[\]]+@[^\s@<>()[\]]+/;
const DEOBFUSCATED_EMAIL = /[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[^\s@<>()[\].]+/;

/** Keep upstream identity text from becoming a published email address. */
export function publicContributorName(name: string, githubLogin: string | null): string {
  const normalized = name.trim().normalize('NFKC');
  const explicit = normalized.replace(/\s*(?:\[at\]|\(at\))\s*/gi, '@').replace(/\s*(?:\[dot\]|\(dot\))\s*/gi, '.');
  const deobfuscated = explicit.replace(/\s+at\s+/gi, '@').replace(/\s+dot\s+/gi, '.');
  if (DIRECT_EMAIL.test(explicit) || DEOBFUSCATED_EMAIL.test(deobfuscated)) {
    return githubLogin || 'Unknown contributor';
  }
  return normalized || githubLogin || 'Unknown contributor';
}
