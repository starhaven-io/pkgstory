import type { DatabaseSync } from "node:sqlite";
import { type D1Mode, d1Apply, d1Select, sqlLit } from "../db/d1remote.ts";
import { getLastSha, setCrawlState } from "../db/db.ts";
import { batchCat, headSha, logSince } from "../git.ts";
import { extractVersion } from "../parse/extract.ts";
import type { Source } from "../sources/index.ts";

export interface SinceResult {
  status: "ok" | "no-cursor" | "up-to-date";
  events: number;
  commits: number;
  head?: string;
}

export interface DeltaEvent {
  version: string;
  revision: number;
  at: number;
  sha: string;
  subject: string;
}

export interface PackageDelta {
  name: string;
  touches: DeltaEvent[]; // time-ordered, only touches that parsed to a version
}

export interface Delta {
  head: string;
  commits: number;
  packages: PackageDelta[];
}

interface RawTouch {
  committedAt: number;
  blobSha: string;
  commitSha: string;
  subject: string;
}

/**
 * Parse `git log <lastSha>..HEAD` into per-package, time-ordered version touches.
 * Store-agnostic — both the local-SQLite and D1 paths build on this.
 */
export function computeDelta(source: Source, lastSha: string): Delta {
  const head = headSha(source.repoDir);
  if (head === lastSha) return { head, commits: 0, packages: [] };

  const commits = logSince(source.repoDir, lastSha); // oldest-first
  const raw = new Map<string, RawTouch[]>();
  const shas: string[] = [];
  for (const commit of commits) {
    for (const file of commit.files) {
      const name = source.packageOf(file.path);
      if (!name || file.status === "D" || /^0+$/.test(file.blobSha)) continue;
      let list = raw.get(name);
      if (!list) {
        list = [];
        raw.set(name, list);
      }
      list.push({
        committedAt: commit.committedAt,
        blobSha: file.blobSha,
        commitSha: commit.sha,
        subject: commit.subject,
      });
      shas.push(file.blobSha);
    }
  }

  const blobs = batchCat(source.repoDir, shas);
  const packages: PackageDelta[] = [];
  for (const [name, touches] of raw) {
    const parsed: DeltaEvent[] = [];
    for (const t of touches) {
      const blob = blobs.get(t.blobSha);
      if (blob === undefined) continue;
      const { version, revision } = extractVersion(source.kind, name, t.subject, blob);
      if (!version) continue;
      parsed.push({ version, revision, at: t.committedAt, sha: t.commitSha, subject: t.subject });
    }
    if (parsed.length > 0) packages.push({ name, touches: parsed });
  }
  return { head, commits: commits.length, packages };
}

/** Emit an event each time (version, revision) changes from the running baseline. */
export function foldPackage(
  baseVersion: string | null,
  baseRevision: number,
  touches: DeltaEvent[],
): { events: DeltaEvent[]; latest: DeltaEvent | null } {
  let lastVersion = baseVersion;
  let lastRevision = baseRevision;
  const events: DeltaEvent[] = [];
  for (const t of touches) {
    if (t.version === lastVersion && t.revision === lastRevision) continue;
    events.push(t);
    lastVersion = t.version;
    lastRevision = t.revision;
  }
  return { events, latest: events.at(-1) ?? null };
}

interface PkgRow {
  id: number;
  latest_version: string | null;
  latest_revision: number;
}

/**
 * Incremental crawl into a local SQLite db. Requires a prior seed (`crawl --all`)
 * so baselines exist; otherwise reports no-cursor.
 */
export function crawlSince(db: DatabaseSync, source: Source, now: number): SinceResult {
  const lastSha = getLastSha(db, source.id);
  if (!lastSha) return { status: "no-cursor", events: 0, commits: 0 };

  const delta = computeDelta(source, lastSha);
  if (delta.head === lastSha) {
    setCrawlState(db, source.id, delta.head, now); // heartbeat even when nothing changed
    return { status: "up-to-date", events: 0, commits: 0, head: delta.head };
  }

  const upsertPkg = db.prepare("INSERT OR IGNORE INTO packages (source, name) VALUES (?, ?)");
  const getPkg = db.prepare(
    "SELECT id, latest_version, latest_revision FROM packages WHERE source = ? AND name = ?",
  );
  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO version_events (package_id, version, revision, introduced_at, commit_sha, subject)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const updateLatest = db.prepare(
    `UPDATE packages
        SET latest_version = ?, latest_revision = ?, latest_at = ?,
            event_count = (SELECT COUNT(*) FROM version_events ve WHERE ve.package_id = ?)
      WHERE id = ?`,
  );

  let events = 0;
  db.exec("BEGIN");
  for (const { name, touches } of delta.packages) {
    upsertPkg.run(source.id, name);
    const pkg = getPkg.get(source.id, name) as unknown as PkgRow;
    const { events: newEvents, latest } = foldPackage(
      pkg.latest_version,
      pkg.latest_revision ?? 0,
      touches,
    );
    for (const e of newEvents) {
      events += Number(
        insertEvent.run(pkg.id, e.version, e.revision, e.at, e.sha, e.subject).changes,
      );
    }
    if (latest) updateLatest.run(latest.version, latest.revision, latest.at, pkg.id, pkg.id);
  }
  db.exec("COMMIT");

  setCrawlState(db, source.id, delta.head, now);
  return { status: "ok", events, commits: delta.commits, head: delta.head };
}

/**
 * Incremental crawl into D1 (via wrangler). Reads cursor + baselines from D1, derives
 * the delta from git, and applies only the new events + latest + cursor as one small
 * SQL batch. No local SQLite — works in an ephemeral CI runner.
 */
export function crawlSinceD1(source: Source, mode: D1Mode, now: number): SinceResult {
  const cur = d1Select(
    mode,
    `SELECT last_sha FROM crawl_state WHERE source = ${sqlLit(source.id)}`,
  );
  const lastSha = (cur[0]?.last_sha as string | undefined) ?? null;
  if (!lastSha) return { status: "no-cursor", events: 0, commits: 0 };

  const delta = computeDelta(source, lastSha);
  const cursorSql = `INSERT INTO crawl_state (source, last_sha, last_crawled_at) VALUES (${sqlLit(source.id)}, ${sqlLit(delta.head)}, ${now}) ON CONFLICT (source) DO UPDATE SET last_sha = excluded.last_sha, last_crawled_at = excluded.last_crawled_at;`;
  if (delta.head === lastSha) {
    d1Apply(mode, cursorSql); // heartbeat
    return { status: "up-to-date", events: 0, commits: 0, head: delta.head };
  }

  // Baselines for just the changed packages.
  const baseline = new Map<string, { version: string | null; revision: number }>();
  const names = delta.packages.map((p) => p.name);
  for (let i = 0; i < names.length; i += 400) {
    const inList = names
      .slice(i, i + 400)
      .map(sqlLit)
      .join(",");
    for (const row of d1Select(
      mode,
      `SELECT name, latest_version, latest_revision FROM packages WHERE source = ${sqlLit(source.id)} AND name IN (${inList})`,
    )) {
      baseline.set(row.name as string, {
        version: (row.latest_version as string | null) ?? null,
        revision: Number(row.latest_revision ?? 0),
      });
    }
  }

  const stmts: string[] = [];
  let events = 0;
  for (const { name, touches } of delta.packages) {
    const base = baseline.get(name);
    const folded = foldPackage(base?.version ?? null, base?.revision ?? 0, touches);
    if (folded.events.length === 0) continue;
    const idSub = `(SELECT id FROM packages WHERE source = ${sqlLit(source.id)} AND name = ${sqlLit(name)})`;
    stmts.push(
      `INSERT OR IGNORE INTO packages (source, name) VALUES (${sqlLit(source.id)}, ${sqlLit(name)});`,
    );
    for (const e of folded.events) {
      stmts.push(
        `INSERT OR IGNORE INTO version_events (package_id, version, revision, introduced_at, commit_sha, subject) VALUES (${idSub}, ${sqlLit(e.version)}, ${e.revision}, ${e.at}, ${sqlLit(e.sha)}, ${sqlLit(e.subject)});`,
      );
      events += 1;
    }
    if (folded.latest) {
      stmts.push(
        `UPDATE packages SET latest_version = ${sqlLit(folded.latest.version)}, latest_revision = ${folded.latest.revision}, latest_at = ${folded.latest.at}, event_count = (SELECT COUNT(*) FROM version_events ve WHERE ve.package_id = packages.id) WHERE source = ${sqlLit(source.id)} AND name = ${sqlLit(name)};`,
      );
    }
  }
  stmts.push(cursorSql);
  d1Apply(mode, `BEGIN TRANSACTION;\n${stmts.join("\n")}\nCOMMIT;\n`);
  return { status: "ok", events, commits: delta.commits, head: delta.head };
}
