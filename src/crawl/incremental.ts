import type { DatabaseSync } from "node:sqlite";
import { type D1Mode, d1Apply, d1Select, ensureD1PackageColumns, sqlLit } from "../db/d1remote.ts";
import { getLastSha, setCrawlState } from "../db/db.ts";
import { batchCat, headSha, logSince, presentPackages } from "../git.ts";
import { extractVersion } from "../parse/extract.ts";
import { type Lifecycle, parseLifecycle } from "../parse/lifecycle.ts";
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
  // Both deprecate!/disable! stanzas from the latest live blob in the window. null
  // means the window had no live blob (only a deletion) — leave the columns as they are.
  lifecycle: Lifecycle | null;
  // Set when the package is absent from the tap at HEAD after this window; null when
  // present (which clears any prior removed flag).
  removed: {
    at: number;
    commit: string;
    renamedTo: string | null;
    migratedTo: string | null;
  } | null;
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
  deleted: boolean;
}

/**
 * Parse `git log <lastSha>..HEAD` into per-package, time-ordered version touches plus
 * each package's current lifecycle and removal state. Store-agnostic — both the
 * local-SQLite and D1 paths build on this.
 */
export function computeDelta(source: Source, lastSha: string): Delta {
  const head = headSha(source.repoDir);
  if (head === lastSha) return { head, commits: 0, packages: [] };

  const commits = logSince(source.repoDir, lastSha); // oldest-first
  const raw = new Map<string, RawTouch[]>();
  const shas: string[] = [];
  let anyDeleted = false;
  for (const commit of commits) {
    for (const file of commit.files) {
      const name = source.packageOf(file.path);
      if (!name) continue;
      const deleted = file.status === "D" || /^0+$/.test(file.blobSha);
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
        deleted,
      });
      if (deleted) anyDeleted = true;
      else shas.push(file.blobSha);
    }
  }

  const blobs = batchCat(source.repoDir, shas);
  // Only resolve the HEAD tree when a deletion appeared — the authoritative check that
  // separates a real removal from a relocation (delete + add in one commit).
  const present = anyDeleted ? presentPackages(source.repoDir, source.dir, source.packageOf) : null;
  // Homebrew normally updates rename/migration metadata in the deleting commit; if a
  // later metadata-only commit reclassifies an old deletion, the full reconcile path
  // backfills it.
  const replacements = anyDeleted ? source.packageReplacements() : null;

  const packages: PackageDelta[] = [];
  for (const [name, touches] of raw) {
    const parsed: DeltaEvent[] = [];
    let latestLive: RawTouch | null = null;
    let lastDeletion: RawTouch | null = null;
    for (const t of touches) {
      // touches are oldest-first, so these settle on the last of each kind.
      if (t.deleted) {
        lastDeletion = t;
        continue;
      }
      latestLive = t;
      const blob = blobs.get(t.blobSha);
      if (blob === undefined) continue;
      const { version, revision } = extractVersion(source.kind, name, t.subject, blob);
      if (version)
        parsed.push({ version, revision, at: t.committedAt, sha: t.commitSha, subject: t.subject });
    }

    const isPresent = present ? present.has(name) : true;
    const replacement = replacements?.get(name);
    const removed =
      !isPresent && lastDeletion
        ? {
            at: lastDeletion.committedAt,
            commit: lastDeletion.commitSha,
            renamedTo: replacement?.renamedTo ?? null,
            migratedTo: replacement?.migratedTo ?? null,
          }
        : null;
    const lifecycle = latestLive ? parseLifecycle(blobs.get(latestLive.blobSha) ?? "") : null;

    packages.push({ name, touches: parsed, lifecycle, removed });
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
  const setLifecycle = db.prepare(
    "UPDATE packages SET deprecate_date = ?, deprecate_reason = ?, disable_date = ?, disable_reason = ? WHERE id = ?",
  );
  const setRemoved = db.prepare(
    "UPDATE packages SET removed_at = ?, removed_commit = ?, renamed_to = ?, migrated_to = ? WHERE id = ?",
  );
  const clearRemoved = db.prepare(
    "UPDATE packages SET removed_at = NULL, removed_commit = NULL, renamed_to = NULL, migrated_to = NULL WHERE id = ? AND (removed_at IS NOT NULL OR renamed_to IS NOT NULL OR migrated_to IS NOT NULL)",
  );

  let events = 0;
  db.exec("BEGIN");
  for (const { name, touches, lifecycle, removed } of delta.packages) {
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
    if (lifecycle)
      setLifecycle.run(
        lifecycle.deprecate?.date ?? null,
        lifecycle.deprecate?.reason ?? null,
        lifecycle.disable?.date ?? null,
        lifecycle.disable?.reason ?? null,
        pkg.id,
      );
    if (removed)
      setRemoved.run(removed.at, removed.commit, removed.renamedTo, removed.migratedTo, pkg.id);
    else clearRemoved.run(pkg.id);
  }
  db.exec("COMMIT");

  setCrawlState(db, source.id, delta.head, now);
  return { status: "ok", events, commits: delta.commits, head: delta.head };
}

interface Baseline {
  version: string | null;
  revision: number;
  deprecateDate: string | null;
  deprecateReason: string | null;
  disableDate: string | null;
  disableReason: string | null;
  removedAt: number | null;
  removedCommit: string | null;
  renamedTo: string | null;
  migratedTo: string | null;
}

/**
 * Incremental crawl into D1 (via wrangler). Reads cursor + baselines from D1, derives
 * the delta from git, and applies only the new events + latest + changed lifecycle/
 * removal + cursor as one small SQL batch. No local SQLite — works in an ephemeral CI
 * runner. Only packages touched in the window are re-derived, so rows removed before
 * rename/migration support existed keep their plain-removed status until a full crawl
 * plus export/import reseed backfills them.
 */
export function crawlSinceD1(source: Source, mode: D1Mode, now: number): SinceResult {
  ensureD1PackageColumns(mode);

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

  // Baselines (version + lifecycle/removal) for just the changed packages.
  const baseline = new Map<string, Baseline>();
  const names = delta.packages.map((p) => p.name);
  for (let i = 0; i < names.length; i += 400) {
    const inList = names
      .slice(i, i + 400)
      .map(sqlLit)
      .join(",");
    for (const row of d1Select(
      mode,
      `SELECT name, latest_version, latest_revision, deprecate_date, deprecate_reason, disable_date, disable_reason, removed_at, removed_commit, renamed_to, migrated_to FROM packages WHERE source = ${sqlLit(source.id)} AND name IN (${inList})`,
    )) {
      baseline.set(row.name as string, {
        version: (row.latest_version as string | null) ?? null,
        revision: Number(row.latest_revision ?? 0),
        deprecateDate: (row.deprecate_date as string | null) ?? null,
        deprecateReason: (row.deprecate_reason as string | null) ?? null,
        disableDate: (row.disable_date as string | null) ?? null,
        disableReason: (row.disable_reason as string | null) ?? null,
        removedAt: row.removed_at != null ? Number(row.removed_at) : null,
        removedCommit: (row.removed_commit as string | null) ?? null,
        renamedTo: (row.renamed_to as string | null) ?? null,
        migratedTo: (row.migrated_to as string | null) ?? null,
      });
    }
  }

  const stmts: string[] = [];
  let events = 0;
  for (const { name, touches, lifecycle, removed } of delta.packages) {
    const base = baseline.get(name);
    const folded = foldPackage(base?.version ?? null, base?.revision ?? 0, touches);

    const lifecycleChanged =
      lifecycle != null &&
      ((lifecycle.deprecate?.date ?? null) !== (base?.deprecateDate ?? null) ||
        (lifecycle.deprecate?.reason ?? null) !== (base?.deprecateReason ?? null) ||
        (lifecycle.disable?.date ?? null) !== (base?.disableDate ?? null) ||
        (lifecycle.disable?.reason ?? null) !== (base?.disableReason ?? null));
    const baseRemoved = base?.removedAt ?? null;
    const removedChanged = removed
      ? removed.at !== baseRemoved ||
        removed.commit !== (base?.removedCommit ?? null) ||
        removed.renamedTo !== (base?.renamedTo ?? null) ||
        removed.migratedTo !== (base?.migratedTo ?? null)
      : baseRemoved != null || base?.renamedTo != null || base?.migratedTo != null;

    if (folded.events.length === 0 && !lifecycleChanged && !removedChanged) continue;

    const where = `source = ${sqlLit(source.id)} AND name = ${sqlLit(name)}`;
    const idSub = `(SELECT id FROM packages WHERE ${where})`;
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
        `UPDATE packages SET latest_version = ${sqlLit(folded.latest.version)}, latest_revision = ${folded.latest.revision}, latest_at = ${folded.latest.at}, event_count = (SELECT COUNT(*) FROM version_events ve WHERE ve.package_id = packages.id) WHERE ${where};`,
      );
    }
    if (lifecycleChanged && lifecycle) {
      stmts.push(
        `UPDATE packages SET deprecate_date = ${sqlLit(lifecycle.deprecate?.date ?? null)}, deprecate_reason = ${sqlLit(lifecycle.deprecate?.reason ?? null)}, disable_date = ${sqlLit(lifecycle.disable?.date ?? null)}, disable_reason = ${sqlLit(lifecycle.disable?.reason ?? null)} WHERE ${where};`,
      );
    }
    if (removedChanged) {
      stmts.push(
        removed
          ? `UPDATE packages SET removed_at = ${removed.at}, removed_commit = ${sqlLit(removed.commit)}, renamed_to = ${sqlLit(removed.renamedTo)}, migrated_to = ${sqlLit(removed.migratedTo)} WHERE ${where};`
          : `UPDATE packages SET removed_at = NULL, removed_commit = NULL, renamed_to = NULL, migrated_to = NULL WHERE ${where};`,
      );
    }
  }
  stmts.push(cursorSql);
  // No BEGIN/COMMIT wrapper: remote D1 rejects SQL transactions in a --file, and the
  // batch is idempotent anyway (INSERT OR IGNORE events + recomputed latest/lifecycle/
  // cursor), so a partial apply is safely re-derived next run. Cursor goes last so it
  // only advances after the rows land. (Same constraint the export slice already follows.)
  d1Apply(mode, `${stmts.join("\n")}\n`);
  return { status: "ok", events, commits: delta.commits, head: delta.head };
}
