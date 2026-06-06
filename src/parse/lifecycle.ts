export interface Stanza {
  date: string | null; // "YYYY-MM-DD" as authored — may be a future, scheduled date
  reason: string | null; // predicate phrasing, reads after "… because it"
}

export interface Lifecycle {
  deprecate: Stanza | null;
  disable: Stanza | null;
}

// Homebrew's lifecycle stanzas, top-level in a formula or inside a cask block. Each
// carries an optional `date:` — often a *future* scheduled date; brew only applies the
// stanza once that date has passed — and a `because:` that is a quoted string or a
// symbol (:repo_archived, :discontinued, …). Both stanzas are kept verbatim; which is
// in effect is a read-time decision against today's date, not the parser's job.
const DISABLE = /^\s*disable!(.*)$/m;
const DEPRECATE = /^\s*deprecate!(.*)$/m;
const DATE = /\bdate:\s*"([^"]+)"/;
const BECAUSE_STR = /\bbecause:\s*"((?:[^"\\]|\\.)*)"/;
const BECAUSE_SYM = /\bbecause:\s*:([a-z0-9_]+)/i;

// Homebrew's canonical `because:` symbols → predicate phrasing that reads after
// "… because it" (mirrors brew's own wording). String reasons are already predicates;
// an unknown symbol falls back to "is <words>" so the sentence stays grammatical.
const REASON_PHRASES: Record<string, string> = {
  does_not_build: "does not build",
  no_license: "has no license",
  repo_archived: "has an archived upstream repository",
  repo_removed: "has a removed upstream repository",
  unmaintained: "is not maintained upstream",
  unsupported: "is not supported upstream",
  deprecated_upstream: "is deprecated upstream",
  versioned_formula: "is a versioned formula",
  discontinued: "is discontinued upstream",
  no_longer_available: "is no longer available upstream",
  checksum_mismatch: "was built with a mismatched checksum",
  fails_gatekeeper_check: "fails the macOS Gatekeeper check",
};

function argsOf(args: string): Stanza {
  const date = args.match(DATE)?.[1] ?? null;
  const str = args.match(BECAUSE_STR)?.[1];
  if (str != null) return { date, reason: str.replace(/\\(.)/g, "$1") };
  const sym = args.match(BECAUSE_SYM)?.[1];
  return { date, reason: sym ? (REASON_PHRASES[sym] ?? `is ${sym.replace(/_/g, " ")}`) : null };
}

/** Both deprecate!/disable! stanzas of a formula or cask blob (date + reason each). */
export function parseLifecycle(src: string): Lifecycle {
  const dep = src.match(DEPRECATE);
  const dis = src.match(DISABLE);
  return {
    deprecate: dep ? argsOf(dep[1] ?? "") : null,
    disable: dis ? argsOf(dis[1] ?? "") : null,
  };
}
