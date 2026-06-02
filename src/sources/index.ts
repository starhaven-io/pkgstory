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
  /** Current sharded path for a package, e.g. `Formula/g/git.rb`. */
  pathFor(name: string): string;
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

function makeSource(def: SourceDef, repoDir: string): Source {
  const dir = def.dir;
  // <dir> as any path component (covers Library/Formula/ and Formula/), then any
  // number of shard subdirs (casks shard fonts two deep: Casks/font/font-a/x.rb),
  // then <name>.rb — so every layout/relocation maps to one package.
  const re = new RegExp(`(?:^|/)${dir}/(?:[^/]+/)*([^/]+)\\.rb$`);
  return {
    ...def,
    repoDir,
    pathFor(name: string): string {
      const first = name[0]?.toLowerCase() ?? "_";
      return `${dir}/${first}/${name}.rb`;
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
