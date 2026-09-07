import { headFile, repoExists, repoRoot } from "../git.ts";

export type SourceId = "homebrew-formula" | "homebrew-cask";
export type PackageKind = "formula" | "cask";

export interface PackageReplacement {
  renamedTo: string | null;
  migratedTo: string | null;
}

export interface Source {
  id: SourceId;
  label: string;
  tap: string;
  dir: string;
  kind: PackageKind;
  repoDir: string;
  /**
   * Current sharded path plus bounded historical shard layouts and the
   * pre-sharding flat path, so a curated crawl sees the whole in-repo history.
   */
  pathsFor(name: string): string[];
  /** Package name for a touched path, keyed on basename so relocations don't matter. */
  packageOf(path: string): string | null;
  /** Current root-level rename/migration metadata, keyed by old package name. */
  packageReplacements(ref?: string): Map<string, PackageReplacement>;
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

export const SOURCE_IDS: readonly SourceId[] = DEFS.map((source) => source.id);

// Observed tap layouts: core shards lib* into Formula/lib/, cask shards fonts two
// deep (Casks/font/font-a/font-abc.rb); everything else by first character.
function shardOf(kind: PackageKind, name: string): string {
  if (kind === "formula" && name.startsWith("lib")) return "lib";
  if (kind === "cask" && name.startsWith("font-")) return `font/font-${name[5] ?? "_"}`;
  return name[0]?.toLowerCase() ?? "_";
}

function shardsFor(kind: PackageKind, name: string): string[] {
  // lib formulae and font casks moved from their original first-character shard
  // into dedicated shard trees. Both paths are part of their version history.
  return [...new Set([shardOf(kind, name), name[0]?.toLowerCase() ?? "_"])];
}

function rootMap(repoDir: string, file: string, ref: string): Map<string, string> {
  const raw = headFile(repoDir, file, ref);
  if (raw === null) return new Map();

  const parsed = JSON.parse(raw) as unknown;
  const out = new Map<string, string>();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [from, to] of Object.entries(parsed)) {
    if (from && typeof to === "string" && to) out.set(from, to);
  }
  return out;
}

function loadPackageReplacements(
  repoDir: string,
  kind: PackageKind,
  ref: string,
): Map<string, PackageReplacement> {
  const renameFile = kind === "formula" ? "formula_renames.json" : "cask_renames.json";
  const out = new Map<string, PackageReplacement>();

  for (const [from, to] of rootMap(repoDir, renameFile, ref)) {
    out.set(from, { renamedTo: to, migratedTo: null });
  }
  for (const [from, to] of rootMap(repoDir, "tap_migrations.json", ref)) {
    const replacement = out.get(from) ?? { renamedTo: null, migratedTo: null };
    replacement.migratedTo = to;
    out.set(from, replacement);
  }
  return out;
}

/** Exported for tests, which point a real Source at a fixture repo. */
export function makeSource(def: SourceDef, repoDir: string): Source {
  const dir = def.dir;
  const validName = /^[a-z0-9][a-z0-9@+_.-]*$/i;
  return {
    ...def,
    repoDir,
    pathsFor(name: string): string[] {
      if (!validName.test(name)) throw new Error(`invalid package name: ${JSON.stringify(name)}`);
      const paths = [
        ...shardsFor(def.kind, name).map((shard) => `${dir}/${shard}/${name}.rb`),
        `${dir}/${name}.rb`,
      ];
      // A handful of casks moved through a noncanonical one-character shard
      // during renames. Keep the glob bounded to exactly one path component.
      if (def.kind === "cask") paths.push(`:(glob)${dir}/?/${name}.rb`);
      if (def.kind === "formula") {
        paths.push(
          ...shardsFor(def.kind, name).map((shard) => `Library/${dir}/${shard}/${name}.rb`),
          `Library/${dir}/${name}.rb`,
        );
      }
      return paths;
    },
    packageOf(path: string): string | null {
      const parts = path.split("/");
      const relative =
        def.kind === "formula" && parts[0] === "Library" && parts[1] === dir
          ? parts.slice(2)
          : parts[0] === dir
            ? parts.slice(1)
            : null;
      const file = relative?.at(-1);
      if (!relative || !file?.endsWith(".rb")) return null;
      const name = file.slice(0, -3);
      if (!validName.test(name)) return null;

      if (def.kind === "cask" && relative.length === 2 && /^[a-z0-9]$/i.test(relative[0] ?? "")) {
        return name;
      }

      const prefix = path.startsWith(`Library/${dir}/`) ? `Library/${dir}` : dir;
      const supported = [
        `${prefix}/${name}.rb`,
        ...shardsFor(def.kind, name).map((shard) => `${prefix}/${shard}/${name}.rb`),
      ];
      return supported.includes(path) ? name : null;
    },
    packageReplacements(ref = "HEAD"): Map<string, PackageReplacement> {
      return loadPackageReplacements(repoDir, def.kind, ref);
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
