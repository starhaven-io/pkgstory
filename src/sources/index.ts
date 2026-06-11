import { repoExists, repoRoot } from "../git.ts";

export type SourceId = "homebrew-formula" | "homebrew-cask";
export type PackageKind = "formula" | "cask";

export interface Source {
  id: SourceId;
  label: string;
  tap: string;
  dir: string;
  kind: PackageKind;
  repoDir: string;
  /**
   * Current sharded path plus the pre-sharding flat path, e.g.
   * `Formula/g/git.rb` and `Formula/git.rb` — so a curated (demo) crawl sees the
   * package's whole in-repo history, not just the post-2023 shard era.
   */
  pathsFor(name: string): string[];
  /** Package name for a touched path, keyed on basename so relocations don't matter. */
  packageOf(path: string): string | null;
}

interface SourceDef {
  id: SourceId;
  label: string;
  tap: string;
  dir: string;
  kind: PackageKind;
}

const DEFS: SourceDef[] = [
  {
    id: "homebrew-formula",
    label: "Homebrew formula",
    tap: "homebrew/core",
    dir: "Formula",
    kind: "formula",
  },
  { id: "homebrew-cask", label: "Homebrew cask", tap: "homebrew/cask", dir: "Casks", kind: "cask" },
];

// Observed tap layouts: core shards lib* into Formula/lib/, cask shards fonts two
// deep (Casks/font/font-a/font-abc.rb); everything else by first character.
function shardOf(kind: PackageKind, name: string): string {
  if (kind === "formula" && name.startsWith("lib")) return "lib";
  if (kind === "cask" && name.startsWith("font-")) return `font/font-${name[5] ?? "_"}`;
  return name[0]?.toLowerCase() ?? "_";
}

function makeSource(def: SourceDef, repoDir: string): Source {
  const dir = def.dir;
  // <dir> as any path component (covers Library/Formula/ and Formula/), then any
  // number of shard subdirs (casks shard fonts two deep: Casks/font/font-a/x.rb),
  // then <name>.rb — so every layout/relocation maps to one package.
  const re = new RegExp(`(?:^|/)${dir}/(?:[^/]+/)*([^/]+)\\.rb$`);
  return {
    ...def,
    repoDir,
    pathsFor(name: string): string[] {
      return [`${dir}/${shardOf(def.kind, name)}/${name}.rb`, `${dir}/${name}.rb`];
    },
    packageOf(path: string): string | null {
      return path.match(re)?.[1] ?? null;
    },
  };
}

/** Sources whose tap is cloned locally (others are skipped). */
export function resolveSources(): Source[] {
  const out: Source[] = [];
  for (const def of DEFS) {
    let repoDir: string;
    try {
      repoDir = repoRoot(def.tap);
    } catch {
      continue;
    }
    if (repoDir && repoExists(repoDir)) out.push(makeSource(def, repoDir));
  }
  return out;
}
