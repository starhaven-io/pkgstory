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

export function githubContributorUrl(login: string | null): string | undefined {
  if (!login) return undefined;
  const bot = login.endsWith('[bot]');
  const name = bot ? login.slice(0, -5) : login;
  if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(name)) return undefined;
  return `https://github.com/${bot ? 'apps/' : ''}${name}`;
}
