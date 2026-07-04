#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildCommitIndex, buildCommitIndexAll } from "./crawl/commit-index.ts";
import { buildEvents } from "./crawl/events.ts";
import { crawlSince, crawlSinceD1 } from "./crawl/incremental.ts";
import { reconcileRemovals } from "./crawl/removals.ts";
import { buildSnapshots } from "./crawl/snapshot.ts";
import { finalizeLatest, openDb, setCrawlState } from "./db/db.ts";
import { exportSlice } from "./db/export.ts";
import { refreshSiteCache } from "./db/sitecache.ts";
import { headSha } from "./git.ts";
import { resolveSources, type Source } from "./sources/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(here, "../pkgstory.db");

const DEMO: Record<string, string[]> = {
  // terraform is here on purpose: removed from core (BUSL), it exercises the removed +
  // disabled lifecycle path in the default demo crawl.
  "homebrew-formula": [
    "git",
    "wget",
    "jq",
    "node",
    "ripgrep",
    "htop",
    "curl",
    "ffmpeg",
    "terraform",
  ],
  "homebrew-cask": ["visual-studio-code", "firefox", "rectangle", "iterm2", "docker"],
};

function list(csv: string | undefined): string[] | null {
  if (!csv) return null;
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function finalize(db: DatabaseSync, source: Source, now: number, writeCursor: boolean): number {
  finalizeLatest(db, source.id);
  const removed = reconcileRemovals(db, source);
  if (writeCursor) setCrawlState(db, source.id, headSha(source.repoDir), now);
  return removed;
}

async function crawl(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: "string" },
      formulae: { type: "string" },
      casks: { type: "string" },
      all: { type: "boolean" },
      since: { type: "boolean" },
      d1: { type: "string" }, // "local" | "remote" — incremental crawl into D1
      source: { type: "string" },
    },
  });

  const dbPath = values.db ?? DEFAULT_DB;
  let sources = resolveSources();
  if (values.source) sources = sources.filter((s) => s.id === values.source);
  if (sources.length === 0) {
    console.error("No matching Homebrew taps found locally.");
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);

  if (values.d1) {
    const d1mode = values.d1 === "remote" ? "remote" : "local";
    console.log(`pkgstory crawl → D1 (${d1mode}) · incremental\n`);
    let seeded = false;
    for (const source of sources) {
      const r = crawlSinceD1(source, d1mode, now);
      if (r.status !== "no-cursor") seeded = true;
      const msg =
        r.status === "ok"
          ? `${r.commits} new commits → ${r.events} version events`
          : r.status === "up-to-date"
            ? "up to date"
            : "no cursor — seed D1 first";
      console.log(`  ${source.label.padEnd(18)} ${msg}`);
    }
    // Republish the KV blobs the site serves from (search index + home payload).
    if (seeded) {
      const { packages } = refreshSiteCache(d1mode);
      console.log(`  site cache         ${packages.toLocaleString()} packages → KV`);
    }
    return;
  }

  const db = openDb(dbPath);
  const mode = values.since ? "incremental" : values.all ? "full catalog" : "demo";
  console.log(`pkgstory crawl → ${dbPath} · ${mode}\n`);

  for (const source of sources) {
    if (values.since) {
      const r = crawlSince(db, source, now);
      if (r.status === "no-cursor") {
        console.log(`  ${source.label.padEnd(18)} no cursor — run 'crawl --all' to seed first`);
      } else if (r.status === "up-to-date") {
        console.log(`  ${source.label.padEnd(18)} up to date`);
      } else {
        console.log(
          `  ${source.label.padEnd(18)} ${r.commits} new commits → ${r.events} version events`,
        );
      }
    } else if (values.all) {
      console.log(`[${source.label}] indexing full history …`);
      const idx = await buildCommitIndexAll(db, source, (c, _r, p) =>
        console.log(`    L0  ${c.toLocaleString()} commits · ${p.toLocaleString()} packages`),
      );
      console.log(
        `  L0: ${idx.rows.toLocaleString()} index rows · ${idx.packages.toLocaleString()} packages`,
      );
      const snaps = buildSnapshots(db, source, (d, t) =>
        console.log(`    L1  ${d.toLocaleString()}/${t.toLocaleString()} snapshots`),
      );
      console.log(`  L1: ${snaps.toLocaleString()} snapshots`);
      const events = buildEvents(db, source);
      const removed = finalize(db, source, now, true);
      console.log(
        `  L2: ${events.toLocaleString()} version events · ${removed.toLocaleString()} removed\n`,
      );
    } else {
      const override = source.id === "homebrew-cask" ? list(values.casks) : list(values.formulae);
      const names = override ?? DEMO[source.id] ?? [];
      if (names.length === 0) continue;
      const commits = buildCommitIndex(db, source, names);
      const snaps = buildSnapshots(db, source);
      const events = buildEvents(db, source);
      const removed = finalize(db, source, now, false);
      console.log(
        `  ${source.label.padEnd(18)} ${commits} commits → ${snaps} snapshots → ${events} version events${removed ? ` · ${removed} removed` : ""}`,
      );
    }
  }

  const checked = db.prepare("SELECT MAX(last_crawled_at) AS at FROM crawl_state").get() as {
    at: number | null;
  };
  if (checked?.at) console.log(`\nlast checked: ${new Date(checked.at * 1000).toISOString()}`);

  sampleTimeline(db);
  db.close();
}

function exportCmd(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { db: { type: "string" } } });
  const db = openDb(values.db ?? DEFAULT_DB);
  exportSlice(db, (chunk) => process.stdout.write(chunk));
  db.close();
}

function cacheCmd(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { d1: { type: "string" } } });
  const mode = values.d1 === "local" ? "local" : "remote";
  const { packages } = refreshSiteCache(mode);
  console.log(`site cache (${mode}): ${packages.toLocaleString()} packages → KV`);
}

interface EventRow {
  version: string;
  revision: number;
  introduced_at: number;
}

function sampleTimeline(db: DatabaseSync): void {
  const top = db
    .prepare(
      `SELECT p.source, p.name, COUNT(*) AS n
         FROM version_events ve JOIN packages p ON p.id = ve.package_id
        GROUP BY ve.package_id ORDER BY n DESC LIMIT 1`,
    )
    .get() as { source: string; name: string; n: number } | undefined;
  if (!top) return;

  const rows = db
    .prepare(
      `SELECT ve.version, ve.revision, ve.introduced_at
         FROM version_events ve JOIN packages p ON p.id = ve.package_id
        WHERE p.source = ? AND p.name = ?
        ORDER BY ve.introduced_at DESC LIMIT 6`,
    )
    .all(top.source, top.name) as unknown as EventRow[];

  console.log(`Sample — ${top.name} (${top.source}), ${top.n} versions tracked:`);
  for (const r of rows) {
    const date = new Date(r.introduced_at * 1000).toISOString().slice(0, 10);
    const rev = r.revision ? `_${r.revision}` : "";
    console.log(`  ${date}  ${r.version}${rev}`);
  }
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "crawl":
    crawl(rest).catch((e) => {
      console.error(e);
      process.exit(1);
    });
    break;
  case "export":
    exportCmd(rest);
    break;
  case "cache":
    cacheCmd(rest);
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(
      [
        "usage:",
        "  pkgstory crawl [--all | --since | --d1 local|remote] [--source <id>] [--db PATH] [--formulae a,b] [--casks a,b]",
        "  pkgstory export [--db PATH]    # emit the D1 site-slice as SQL on stdout",
        "  pkgstory cache [--d1 local|remote]  # rebuild the site-cache KV blobs from D1",
      ].join("\n"),
    );
    break;
  default:
    console.error(`unknown command: ${command}`);
    process.exit(2);
}
