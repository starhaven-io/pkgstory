export type LifecycleState = "deprecated" | "disabled";

export interface Lifecycle {
  state: LifecycleState | null;
  date: string | null; // "YYYY-MM-DD" as authored in the stanza
  reason: string | null; // the `because:` text (symbols humanized: :repo_archived → "repo archived")
}

const NONE: Lifecycle = { state: null, date: null, reason: null };

// Homebrew's lifecycle stanzas, top-level in a formula or inside a cask block. Both
// carry an optional `date:` and a `because:` that is either a quoted string or a
// symbol (:repo_archived, :discontinued, …). `disable!` outranks `deprecate!` — a
// disabled package no longer installs — so a formula carrying both reads as disabled.
const DISABLE = /^\s*disable!(.*)$/m;
const DEPRECATE = /^\s*deprecate!(.*)$/m;
const DATE = /\bdate:\s*"([^"]+)"/;
const BECAUSE_STR = /\bbecause:\s*"((?:[^"\\]|\\.)*)"/;
const BECAUSE_SYM = /\bbecause:\s*:([a-z0-9_]+)/i;

function argsOf(args: string): { date: string | null; reason: string | null } {
  const date = args.match(DATE)?.[1] ?? null;
  const str = args.match(BECAUSE_STR)?.[1];
  if (str != null) return { date, reason: str.replace(/\\(.)/g, "$1") };
  const sym = args.match(BECAUSE_SYM)?.[1];
  return { date, reason: sym ? sym.replace(/_/g, " ") : null };
}

/** Current deprecate!/disable! state of a formula or cask blob (the "why" + when). */
export function parseLifecycle(src: string): Lifecycle {
  const dis = src.match(DISABLE);
  if (dis) return { state: "disabled", ...argsOf(dis[1] ?? "") };
  const dep = src.match(DEPRECATE);
  if (dep) return { state: "deprecated", ...argsOf(dep[1] ?? "") };
  return NONE;
}
