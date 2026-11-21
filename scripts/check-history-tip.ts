import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { batchCat } from "../src/git.ts";
import { parseCask } from "../src/parse/cask.ts";
import { parseFormula } from "../src/parse/formula.ts";
import { resolveSources, SOURCE_IDS, type Source } from "../src/sources/index.ts";

interface PackageReference {
  stable_version?: string;
  version?: string;
  revision?: number;
  ruby_source_checksum: string | { ":sha256": string };
}

function packageTree(source: Source, ref: string): Map<string, string> {
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`Invalid ${source.id} revision: ${ref}`);
  const listing = execFileSync(
    "git",
    [
      "-C",
      source.repoDir,
      "ls-tree",
      "-rz",
      "--format=%(objectname)%x09%(path)",
      ref,
      "--",
      source.dir,
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const files = new Map<string, string>();
  for (const entry of listing.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    const name = source.packageOf(entry.slice(tab + 1));
    if (name) {
      if (files.has(name)) throw new Error(`Multiple paths for ${name} at ${ref}`);
      files.set(name, entry.slice(0, tab));
    }
  }
  return files;
}

function compareSource(
  db: DatabaseSync,
  source: Source,
  reference: string,
  packages: Record<string, PackageReference>,
): boolean {
  const cursor = db.prepare("SELECT mainline_sha FROM crawl_state WHERE source = ?").get(source.id);
  if (typeof cursor?.mainline_sha !== "string")
    throw new Error(`Seed has no cursor for ${source.id}`);
  const files = packageTree(source, reference);
  const seedFiles =
    reference === cursor.mainline_sha ? files : packageTree(source, cursor.mainline_sha);
  const stored = new Map(
    db
      .prepare(
        "SELECT name, latest_version, latest_revision, removed_at FROM packages WHERE source = ?",
      )
      .all(source.id)
      .map((row) => [row.name, row]),
  );
  const entries = Object.entries(packages);
  let parsed = 0,
    sameSource = 0,
    storedMatches = 0,
    changedSource = 0,
    noVersion = 0;
  for (let start = 0; start < entries.length; start += 500) {
    const chunk = entries.slice(start, start + 500).map(([name, entry]) => {
      const sha = files.get(name);
      if (!sha) throw new Error(`${source.id}/${name} missing at ${reference}`);
      return { name, entry, sha };
    });
    const blobs = batchCat(
      source.repoDir,
      chunk.map(({ sha }) => sha),
    );
    for (const { name, entry, sha } of chunk) {
      const blob = blobs.get(sha);
      if (blob === undefined)
        throw new Error(`Missing source blob ${sha} for ${source.id}/${name}`);
      const checksum =
        typeof entry.ruby_source_checksum === "string"
          ? entry.ruby_source_checksum
          : entry.ruby_source_checksum[":sha256"];
      if (createHash("sha256").update(blob).digest("hex") !== checksum)
        throw new Error(`Source checksum mismatch for ${source.id}/${name} at ${reference}`);
      const version = source.kind === "formula" ? entry.stable_version : entry.version;
      if (version == null) {
        noVersion++;
        continue;
      }
      const revision = source.kind === "formula" ? (entry.revision ?? 0) : 0;
      const result =
        source.kind === "formula" ? parseFormula(blob, name) : { ...parseCask(blob), revision: 0 };
      if (result.version === version && result.revision === revision) parsed++;
      else
        console.error(
          `${source.id}/${name}: parsed ${result.version} revision ${result.revision}, expected ${version} revision ${revision}`,
        );
      if (sha !== seedFiles.get(name)) {
        changedSource++;
        continue;
      }
      sameSource++;
      const row = stored.get(name);
      if (
        row &&
        row.removed_at === null &&
        row.latest_version === version &&
        row.latest_revision === revision
      )
        storedMatches++;
      else
        console.error(
          `${source.id}/${name}: stored ${row?.latest_version} revision ${row?.latest_revision}, removed_at=${row?.removed_at}, expected active ${version} revision ${revision}`,
        );
    }
  }
  const comparable = entries.length - noVersion;
  console.log(
    `${source.id} metadata ${reference}, seed ${cursor.mainline_sha}: parser ${parsed}/${comparable}, stored ${storedMatches}/${sameSource} identical sources, ${changedSource} changed sources, ${noVersion} without a reference version`,
  );
  return parsed === comparable && sameSource > 0 && storedMatches === sameSource;
}

try {
  const [database, metadata] = process.argv.slice(2);
  if (process.argv.length !== 4 || !database || !metadata)
    throw new Error("Usage: node scripts/check-history-tip.ts FULL-CRAWL.db PACKAGES.jws.json");
  const api = JSON.parse(JSON.parse(readFileSync(metadata, "utf8")).payload);
  if (!/^arm64_(?!linux)[a-z_]+$/.test(api.metadata.bottle_tag))
    throw new Error("Select the Apple Silicon macOS package metadata");
  console.log(`Homebrew ${api.metadata.homebrew_version}, ${api.metadata.bottle_tag}`);
  const sources = resolveSources();
  if (sources.length !== SOURCE_IDS.length)
    throw new Error("Both Homebrew tap checkouts are required");
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    for (const source of sources) {
      const entries = source.kind === "formula" ? api.formulae : api.casks;
      if (!compareSource(db, source, api[`${source.kind}_tap_git_head`], entries))
        process.exitCode = 1;
    }
  } finally {
    db.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
