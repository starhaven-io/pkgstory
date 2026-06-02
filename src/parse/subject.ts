function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fallback version from a Homebrew bump commit subject, e.g. `git 2.54.0` or
 * `visual-studio-code 1.122.1 (#12345)`. Used only when the blob yields no version.
 */
export function versionFromSubject(name: string, subject: string): string | null {
  const re = new RegExp(`^${escapeRe(name)}\\s+v?(\\S+?)(?:\\s+\\(#\\d+\\))?$`);
  const m = subject.match(re);
  return m?.[1] ?? null;
}
