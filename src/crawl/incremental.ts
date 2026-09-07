import type { DatabaseSync } from "node:sqlite";
import { type ContributorAttribution, commitAttributions } from "../contributors.ts";
import { type D1Mode, d1Apply, d1ApplyCommand, d1Select, sqlLit } from "../db/d1remote.ts";
import { getLastSha, setCrawlState } from "../db/db.ts";
import { assertAncestor, batchCat, headSha, logSince, presentPackages } from "../git.ts";
import { extractVersion } from "../parse/extract.ts";
import { type Lifecycle, parseLifecycle } from "../parse/lifecycle.ts";
import type { Source } from "../sources/index.ts";
import { contributorWriter, rebuildPackageContributors } from "./contributors.ts";

export interface SinceResult {
  status: "ok" | "no-cursor" | "up-to-date";
  events: number;
  commits: number;
  head?: string;
}

export interface DeltaTouch {
  version: string | null;
  revision: number;
  bottled: boolean;
  bottleTags: string[];
  at: number;
  sha: string;
  subject: string;
}

export interface DeltaEvent extends Omit<DeltaTouch, "version"> {
  version: string;
}

export interface BottleTransition extends DeltaTouch {
  tag: string;
  available: boolean;
}

function isVersionedTouch(touch: DeltaTouch): touch is DeltaEvent {
  return touch.version !== null;
}

export interface PackageDelta {
  name: string;
  touches: DeltaTouch[]; // topology-ordered package states; deletions carry an empty tag set
  history: HistoryTouch[]; // one row per touching commit, including non-version changes
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

export interface HistoryTouch {
  at: number;
  blobSha: string;
  sha: string;
  subject: string;
  status: string;
  deleted: boolean;
  contributors: ContributorAttribution[];
}

export interface Delta {
  head: string;
  commits: number;
  packages: PackageDelta[];
}

type RawTouch = HistoryTouch;

/**
 * Parse `git log <lastSha>..HEAD` into per-package, topology-ordered version touches plus
 * each package's current lifecycle and removal state. Store-agnostic — both the
 * local-SQLite and D1 paths build on this.
 */
export function computeDelta(source: Source, lastSha: string): Delta {
  const head = headSha(source.repoDir);
  if (head === lastSha) return { head, commits: 0, packages: [] };

  assertAncestor(source.repoDir, lastSha, head);
  const commits = logSince(source.repoDir, lastSha, head); // oldest-first
  const raw = new Map<string, RawTouch[]>();
  const shas: string[] = [];
  let anyDeleted = false;
  for (const commit of commits) {
    const contributors = commitAttributions(commit);
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
        at: commit.committedAt,
        blobSha: file.blobSha,
        sha: commit.sha,
        subject: commit.subject,
        status: file.status,
        deleted,
        contributors,
      });
      if (deleted) anyDeleted = true;
      else shas.push(file.blobSha);
    }
  }

  const blobs = batchCat(source.repoDir, shas);
  // Only resolve the HEAD tree when a deletion appeared — the authoritative check that
  // separates a real removal from a relocation (delete + add in one commit).
  const present = anyDeleted
    ? presentPackages(source.repoDir, source.dir, source.packageOf, head)
    : null;
  // Homebrew normally updates rename/migration metadata in the deleting commit; if a
  // later metadata-only commit reclassifies an old deletion, the full reconcile path
  // backfills it.
  const replacements = anyDeleted ? source.packageReplacements(head) : null;

  const packages: PackageDelta[] = [];
  for (const [name, touches] of raw) {
    const parsed = new Map<string, DeltaTouch>();
    const historyBySha = new Map<string, HistoryTouch>();
    let latestLive: RawTouch | null = null;
    let lastDeletion: RawTouch | null = null;
    for (const t of touches) {
      const prior = historyBySha.get(t.sha);
      if (!prior || (prior.deleted && !t.deleted)) historyBySha.set(t.sha, t);
      // touches are oldest-first, so these settle on the last of each kind.
      if (t.deleted) {
        lastDeletion = t;
        if (!parsed.has(t.sha))
          parsed.set(t.sha, {
            version: null,
            revision: 0,
            bottled: false,
            bottleTags: [],
            at: t.at,
            sha: t.sha,
            subject: t.subject,
          });
        continue;
      }
      latestLive = t;
      const blob = blobs.get(t.blobSha);
      if (blob === undefined) throw new Error(`blob ${t.blobSha} was not returned by git cat-file`);
      const { version, revision, bottled, bottleTags } = extractVersion(
        source.kind,
        name,
        t.subject,
        blob,
      );
      parsed.set(t.sha, {
        version,
        revision,
        bottled,
        bottleTags,
        at: t.at,
        sha: t.sha,
        subject: t.subject,
      });
    }

    const isPresent = present ? present.has(name) : true;
    const replacement = replacements?.get(name);
    const removed =
      !isPresent && lastDeletion
        ? {
            at: lastDeletion.at,
            commit: lastDeletion.sha,
            renamedTo: replacement?.renamedTo ?? null,
            migratedTo: replacement?.migratedTo ?? null,
          }
        : null;
    const lifecycle = latestLive ? parseLifecycle(blobs.get(latestLive.blobSha) ?? "") : null;

    packages.push({
      name,
      touches: [...parsed.values()],
      history: [...historyBySha.values()],
      lifecycle,
      removed,
    });
  }
  return { head, commits: commits.length, packages };
}

/** Emit version changes plus formula-wide and per-tag bottle transitions. */
export function foldPackage(
  baseVersion: string | null,
  baseRevision: number,
  baseBottled: boolean | null,
  baseBottleTags: string[] | null,
  newPackage: boolean,
  touches: DeltaTouch[],
): {
  events: DeltaEvent[];
  bottleEvents: DeltaTouch[];
  bottleTransitions: BottleTransition[];
  latest: DeltaEvent | null;
  bottled: boolean | null;
  bottleTags: string[] | null;
} {
  let lastVersion = baseVersion;
  let lastRevision = baseRevision;
  let lastBottled = baseBottled;
  let lastTags = baseBottleTags === null ? null : new Set(baseBottleTags);
  const events: DeltaEvent[] = [];
  const bottleEvents: DeltaTouch[] = [];
  const bottleTransitions: BottleTransition[] = [];
  for (const t of touches) {
    if (isVersionedTouch(t) && (t.version !== lastVersion || t.revision !== lastRevision)) {
      events.push(t);
      lastVersion = t.version;
      lastRevision = t.revision;
    }
    if (
      (lastBottled === null && newPackage && t.bottled) ||
      (lastBottled !== null && t.bottled !== lastBottled)
    )
      bottleEvents.push(t);
    lastBottled = t.bottled;

    const tags = new Set(t.bottleTags);
    if (lastTags === null) {
      if (!newPackage) {
        lastTags = tags;
        continue;
      }
      lastTags = new Set();
    }
    for (const tag of tags) {
      if (!lastTags.has(tag)) bottleTransitions.push({ ...t, tag, available: true });
    }
    for (const tag of lastTags) {
      if (!tags.has(tag)) bottleTransitions.push({ ...t, tag, available: false });
    }
    lastTags = tags;
  }
  return {
    events,
    bottleEvents,
    bottleTransitions,
    latest: events.at(-1) ?? null,
    bottled: touches.length ? lastBottled : null,
    bottleTags: touches.length && lastTags !== null ? [...lastTags].sort() : null,
  };
}

interface PkgRow {
  id: number;
  latest_version: string | null;
  latest_revision: number;
  latest_bottled: number | null;
  latest_bottle_tags: string | null;
}

export interface ContributionAggregate {
  contributor: ContributorAttribution;
  touchCount: number;
  versionCount: number;
  firstAt: number;
  lastAt: number;
}

export function aggregateContributions(
  history: HistoryTouch[],
  versionEvents: DeltaEvent[],
): ContributionAggregate[] {
  const versionShas = new Set(versionEvents.map((event) => event.sha));
  const aggregates = new Map<string, ContributionAggregate>();
  for (const touch of history) {
    for (const contributor of touch.contributors) {
      const existing = aggregates.get(contributor.key);
      if (existing) {
        existing.contributor = contributor;
        existing.touchCount += 1;
        if (versionShas.has(touch.sha)) existing.versionCount += 1;
        existing.firstAt = Math.min(existing.firstAt, touch.at);
        existing.lastAt = Math.max(existing.lastAt, touch.at);
      } else {
        aggregates.set(contributor.key, {
          contributor,
          touchCount: 1,
          versionCount: versionShas.has(touch.sha) ? 1 : 0,
          firstAt: touch.at,
          lastAt: touch.at,
        });
      }
    }
  }
  return [...aggregates.values()];
}

export function contributionStatements(
  packageIdSql: string,
  windowStartSha: string,
  windowEndSha: string,
  contributions: ContributionAggregate[],
): string[] {
  const statements: string[] = [];
  for (const aggregate of contributions) {
    const contributor = aggregate.contributor;
    statements.push(
      `INSERT INTO contributors (contributor_key, display_name, github_login, is_bot, last_seen_at) VALUES (${sqlLit(contributor.key)}, ${sqlLit(contributor.displayName)}, ${sqlLit(contributor.githubLogin)}, ${contributor.isBot ? 1 : 0}, ${sqlLit(aggregate.lastAt)}) ON CONFLICT (contributor_key) DO UPDATE SET display_name = excluded.display_name, github_login = COALESCE(excluded.github_login, contributors.github_login), is_bot = excluded.is_bot, last_seen_at = excluded.last_seen_at WHERE excluded.last_seen_at >= contributors.last_seen_at;`,
      `INSERT INTO package_contribution_slices (package_id, contributor_key, window_start_sha, window_end_sha, touch_count, version_count, first_at, last_at) VALUES (${packageIdSql}, ${sqlLit(contributor.key)}, ${sqlLit(windowStartSha)}, ${sqlLit(windowEndSha)}, ${sqlLit(aggregate.touchCount)}, ${sqlLit(aggregate.versionCount)}, ${sqlLit(aggregate.firstAt)}, ${sqlLit(aggregate.lastAt)}) ON CONFLICT (package_id, contributor_key, window_start_sha) DO UPDATE SET window_end_sha = excluded.window_end_sha, touch_count = excluded.touch_count, version_count = excluded.version_count, first_at = excluded.first_at, last_at = excluded.last_at;`,
    );
  }
  return statements;
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
    "SELECT id, latest_version, latest_revision, latest_bottled, latest_bottle_tags FROM packages WHERE source = ? AND name = ?",
  );
  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO version_events (package_id, version, revision, introduced_at, commit_sha, subject)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertVersionChange = db.prepare(
    `INSERT OR IGNORE INTO version_changes
       (package_id, commit_sha, version, revision, changed_at, history_order, subject)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertBottleEvent = db.prepare(
    `INSERT OR IGNORE INTO bottle_events
       (package_id, bottled, version, revision, changed_at, commit_sha, subject)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertBottleInterval = db.prepare(
    `INSERT OR IGNORE INTO bottle_intervals
       (package_id, tag, started_at, started_commit, started_subject,
        started_version, started_revision)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const closeBottleInterval = db.prepare(
    `UPDATE bottle_intervals
        SET ended_at = ?, ended_commit = ?, ended_subject = ?,
            ended_version = ?, ended_revision = ?
      WHERE package_id = ? AND tag = ? AND ended_at IS NULL
        AND EXISTS (
          SELECT 1 FROM commit_index opened JOIN commit_index closed
            ON closed.package_id = opened.package_id
           WHERE opened.package_id = bottle_intervals.package_id
             AND opened.commit_sha = bottle_intervals.started_commit
             AND closed.commit_sha = ?
             AND opened.history_order < closed.history_order
        )
        AND NOT EXISTS (
          SELECT 1 FROM bottle_intervals closed
           WHERE closed.package_id = bottle_intervals.package_id
             AND closed.tag = bottle_intervals.tag
             AND closed.ended_commit = ?
        )`,
  );
  const updateLatest = db.prepare(
    `UPDATE packages
        SET latest_version = ?, latest_revision = ?,
            latest_at = ?,
            event_count = (SELECT COUNT(*) FROM version_events ve WHERE ve.package_id = ?)
      WHERE id = ?`,
  );
  const setLifecycle = db.prepare(
    "UPDATE packages SET deprecate_date = ?, deprecate_reason = ?, disable_date = ?, disable_reason = ? WHERE id = ?",
  );
  const updateBottleState = db.prepare(
    `UPDATE packages
        SET latest_bottled = ?,
            bottle_event_count = (SELECT COUNT(*) FROM bottle_events be WHERE be.package_id = ?)
      WHERE id = ?`,
  );
  const updateBottleTags = db.prepare(
    `UPDATE packages
        SET latest_bottle_tags = ?,
            bottle_interval_count = (SELECT COUNT(*) FROM bottle_intervals bi WHERE bi.package_id = ?)
      WHERE id = ?`,
  );
  const setRemoved = db.prepare(
    "UPDATE packages SET removed_at = ?, removed_commit = ?, renamed_to = ?, migrated_to = ? WHERE id = ?",
  );
  const clearRemoved = db.prepare(
    "UPDATE packages SET removed_at = NULL, removed_commit = NULL, renamed_to = NULL, migrated_to = NULL WHERE id = ? AND (removed_at IS NOT NULL OR renamed_to IS NOT NULL OR migrated_to IS NOT NULL)",
  );
  const insertCommit = db.prepare(
    `INSERT OR IGNORE INTO commit_index
       (package_id, commit_sha, blob_sha, committed_at, history_order, author, subject, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const latestHistoryOrder = db.prepare(
    "SELECT COALESCE(MAX(history_order), -1) AS value FROM commit_index WHERE package_id = ?",
  );
  const contributors = contributorWriter(db);

  let events = 0;
  const changedPackageIds: number[] = [];
  db.exec("BEGIN");
  for (const { name, touches, history, lifecycle, removed } of delta.packages) {
    const newPackage = Number(upsertPkg.run(source.id, name).changes) > 0;
    const pkg = getPkg.get(source.id, name) as unknown as PkgRow;
    changedPackageIds.push(pkg.id);
    const baseHistoryOrder = (latestHistoryOrder.get(pkg.id) as unknown as { value: number }).value;
    const historyOrderBySha = new Map<string, number>();
    for (const [offset, touch] of history.entries()) {
      const historyOrder = baseHistoryOrder + offset + 1;
      historyOrderBySha.set(touch.sha, historyOrder);
      const author = touch.contributors.find((contributor) => contributor.role === "author");
      insertCommit.run(
        pkg.id,
        touch.sha,
        touch.blobSha,
        touch.at,
        historyOrder,
        author?.displayName ?? null,
        touch.subject,
        touch.status,
      );
      contributors.linkAttributions(pkg.id, touch.sha, touch.at, touch.contributors);
    }
    const folded = foldPackage(
      pkg.latest_version,
      pkg.latest_revision ?? 0,
      pkg.latest_bottled == null ? null : pkg.latest_bottled !== 0,
      pkg.latest_bottle_tags == null ? null : (JSON.parse(pkg.latest_bottle_tags) as string[]),
      newPackage,
      touches,
    );
    for (const e of folded.events) {
      const historyOrder = historyOrderBySha.get(e.sha);
      if (historyOrder === undefined) {
        throw new Error(`version change ${e.sha} has no package history row`);
      }
      insertVersionChange.run(pkg.id, e.sha, e.version, e.revision, e.at, historyOrder, e.subject);
      events += Number(
        insertEvent.run(pkg.id, e.version, e.revision, e.at, e.sha, e.subject).changes,
      );
    }
    for (const e of folded.bottleEvents) {
      insertBottleEvent.run(
        pkg.id,
        e.bottled ? 1 : 0,
        e.version,
        e.revision,
        e.at,
        e.sha,
        e.subject,
      );
    }
    for (const transition of folded.bottleTransitions) {
      if (transition.available) {
        insertBottleInterval.run(
          pkg.id,
          transition.tag,
          transition.at,
          transition.sha,
          transition.subject,
          transition.version,
          transition.revision,
        );
      } else {
        closeBottleInterval.run(
          transition.at,
          transition.sha,
          transition.subject,
          transition.version,
          transition.revision,
          pkg.id,
          transition.tag,
          transition.sha,
          transition.sha,
        );
      }
    }
    if (folded.latest)
      updateLatest.run(
        folded.latest.version,
        folded.latest.revision,
        folded.latest.at,
        pkg.id,
        pkg.id,
      );
    if (folded.bottled !== null) updateBottleState.run(folded.bottled ? 1 : 0, pkg.id, pkg.id);
    if (folded.bottleTags !== null)
      updateBottleTags.run(JSON.stringify(folded.bottleTags), pkg.id, pkg.id);
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
  rebuildPackageContributors(db, changedPackageIds);
  db.prepare("UPDATE contributor_seeds SET seeded_at_sha = ? WHERE source = ?").run(
    delta.head,
    source.id,
  );
  setCrawlState(db, source.id, delta.head, now);
  db.exec("COMMIT");

  return { status: "ok", events, commits: delta.commits, head: delta.head };
}

interface Baseline {
  version: string | null;
  revision: number;
  bottled: boolean | null;
  bottleTags: string[] | null;
  deprecateDate: string | null;
  deprecateReason: string | null;
  disableDate: string | null;
  disableReason: string | null;
  removedAt: number | null;
  removedCommit: string | null;
  renamedTo: string | null;
  migratedTo: string | null;
  changeOrder: number;
}

/**
 * Incremental crawl into D1 (via wrangler). Reads cursor + baselines from D1, derives
 * the delta from git, and applies only the new events + latest + changed lifecycle/
 * removal + cursor as one small SQL batch. No local SQLite — works in an ephemeral CI
 * runner. Only packages touched in the window are re-derived, so rows removed before
 * rename/migration support existed keep their plain-removed status until a full crawl
 * plus export/import reseed backfills them.
 *
 * Callers must run ensureD1Schema first (once per process, not once per source —
 * each ensure probe costs a wrangler spawn).
 */
export function crawlSinceD1(source: Source, mode: D1Mode, now: number): SinceResult {
  const cur = d1Select(
    mode,
    `SELECT last_sha FROM crawl_state WHERE source = ${sqlLit(source.id)}`,
  );
  const lastSha = (cur[0]?.last_sha as string | undefined) ?? null;
  if (!lastSha) return { status: "no-cursor", events: 0, commits: 0 };
  const contributorSeeded =
    d1Select(mode, `SELECT 1 FROM contributor_seeds WHERE source = ${sqlLit(source.id)} LIMIT 1`)
      .length > 0;

  const delta = computeDelta(source, lastSha);
  const cursorSql = `INSERT INTO crawl_state (source, last_sha, last_crawled_at) VALUES (${sqlLit(source.id)}, ${sqlLit(delta.head)}, ${sqlLit(now)}) ON CONFLICT (source) DO UPDATE SET last_sha = excluded.last_sha, last_crawled_at = excluded.last_crawled_at;`;
  if (delta.head === lastSha) {
    d1ApplyCommand(mode, cursorSql); // one statement; no blocking D1 import needed
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
      `SELECT name, latest_version, latest_revision, latest_bottled, latest_bottle_tags,
              deprecate_date, deprecate_reason, disable_date, disable_reason,
              removed_at, removed_commit, renamed_to, migrated_to,
              COALESCE((SELECT MAX(vc.history_order) FROM version_changes vc WHERE vc.package_id = packages.id), -1) AS change_order
         FROM packages
        WHERE source = ${sqlLit(source.id)} AND name IN (${inList})`,
    )) {
      baseline.set(row.name as string, {
        version: (row.latest_version as string | null) ?? null,
        revision: Number(row.latest_revision ?? 0),
        bottled: row.latest_bottled == null ? null : Number(row.latest_bottled) !== 0,
        bottleTags:
          row.latest_bottle_tags == null
            ? null
            : (JSON.parse(String(row.latest_bottle_tags)) as string[]),
        deprecateDate: (row.deprecate_date as string | null) ?? null,
        deprecateReason: (row.deprecate_reason as string | null) ?? null,
        disableDate: (row.disable_date as string | null) ?? null,
        disableReason: (row.disable_reason as string | null) ?? null,
        removedAt: row.removed_at != null ? Number(row.removed_at) : null,
        removedCommit: (row.removed_commit as string | null) ?? null,
        renamedTo: (row.renamed_to as string | null) ?? null,
        migratedTo: (row.migrated_to as string | null) ?? null,
        changeOrder: Number(row.change_order ?? -1),
      });
    }
  }

  const stmts: string[] = [];
  let events = 0;
  for (const { name, touches, history, lifecycle, removed } of delta.packages) {
    const base = baseline.get(name);
    const folded = foldPackage(
      base?.version ?? null,
      base?.revision ?? 0,
      base?.bottled ?? null,
      base?.bottleTags ?? null,
      base === undefined,
      touches,
    );
    const bottleStateChanged =
      folded.bottled !== null && folded.bottled !== (base?.bottled ?? null);
    const bottleTagsChanged =
      folded.bottleTags !== null &&
      JSON.stringify(folded.bottleTags) !== JSON.stringify(base?.bottleTags ?? null);
    const contributions = contributorSeeded ? aggregateContributions(history, folded.events) : [];

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

    if (
      contributions.length === 0 &&
      folded.events.length === 0 &&
      folded.bottleEvents.length === 0 &&
      folded.bottleTransitions.length === 0 &&
      !bottleStateChanged &&
      !bottleTagsChanged &&
      !lifecycleChanged &&
      !removedChanged
    )
      continue;

    const where = `source = ${sqlLit(source.id)} AND name = ${sqlLit(name)}`;
    const idSub = `(SELECT id FROM packages WHERE ${where})`;
    stmts.push(
      `INSERT OR IGNORE INTO packages (source, name) VALUES (${sqlLit(source.id)}, ${sqlLit(name)});`,
    );
    stmts.push(...contributionStatements(idSub, lastSha, delta.head, contributions));
    for (const [eventOffset, e] of folded.events.entries()) {
      const historyOrder = (base?.changeOrder ?? -1) + eventOffset + 1;
      stmts.push(
        `INSERT OR IGNORE INTO version_changes (package_id, commit_sha, version, revision, changed_at, history_order, subject) VALUES (${idSub}, ${sqlLit(e.sha)}, ${sqlLit(e.version)}, ${sqlLit(e.revision)}, ${sqlLit(e.at)}, ${sqlLit(historyOrder)}, ${sqlLit(e.subject)});`,
        `INSERT OR IGNORE INTO version_events (package_id, version, revision, introduced_at, commit_sha, subject) VALUES (${idSub}, ${sqlLit(e.version)}, ${sqlLit(e.revision)}, ${sqlLit(e.at)}, ${sqlLit(e.sha)}, ${sqlLit(e.subject)});`,
      );
      events += 1;
    }
    for (const e of folded.bottleEvents) {
      stmts.push(
        `INSERT OR IGNORE INTO bottle_events (package_id, bottled, version, revision, changed_at, commit_sha, subject) VALUES (${idSub}, ${e.bottled ? 1 : 0}, ${sqlLit(e.version)}, ${sqlLit(e.revision)}, ${sqlLit(e.at)}, ${sqlLit(e.sha)}, ${sqlLit(e.subject)});`,
      );
    }
    for (const [offset, transition] of folded.bottleTransitions.entries()) {
      // Replayed windows may already contain a later open interval. Bound by
      // commit order, not timestamps: committer clocks can move backwards.
      const laterStarts = folded.bottleTransitions
        .slice(offset + 1)
        .filter((later) => later.available && later.tag === transition.tag)
        .map((later) => sqlLit(later.sha));
      const beforeLaterStarts =
        laterStarts.length > 0 ? ` AND started_commit NOT IN (${laterStarts.join(",")})` : "";
      stmts.push(
        transition.available
          ? `INSERT OR IGNORE INTO bottle_intervals (package_id, tag, started_at, started_commit, started_subject, started_version, started_revision) VALUES (${idSub}, ${sqlLit(transition.tag)}, ${sqlLit(transition.at)}, ${sqlLit(transition.sha)}, ${sqlLit(transition.subject)}, ${sqlLit(transition.version)}, ${sqlLit(transition.revision)});`
          : `UPDATE bottle_intervals SET ended_at = ${sqlLit(transition.at)}, ended_commit = ${sqlLit(transition.sha)}, ended_subject = ${sqlLit(transition.subject)}, ended_version = ${sqlLit(transition.version)}, ended_revision = ${sqlLit(transition.revision)} WHERE package_id = ${idSub} AND tag = ${sqlLit(transition.tag)} AND ended_at IS NULL${beforeLaterStarts} AND NOT EXISTS (SELECT 1 FROM bottle_intervals closed WHERE closed.package_id = ${idSub} AND closed.tag = ${sqlLit(transition.tag)} AND closed.ended_commit = ${sqlLit(transition.sha)});`,
      );
    }
    if (folded.latest) {
      stmts.push(
        `UPDATE packages SET latest_version = ${sqlLit(folded.latest.version)}, latest_revision = ${sqlLit(folded.latest.revision)}, latest_at = ${sqlLit(folded.latest.at)}, event_count = (SELECT COUNT(*) FROM version_events ve WHERE ve.package_id = packages.id) WHERE ${where};`,
      );
    }
    if (folded.bottled !== null && (bottleStateChanged || folded.bottleEvents.length > 0)) {
      stmts.push(
        `UPDATE packages SET latest_bottled = ${folded.bottled ? 1 : 0}, bottle_event_count = (SELECT COUNT(*) FROM bottle_events be WHERE be.package_id = packages.id) WHERE ${where};`,
      );
    }
    if (folded.bottleTags !== null && (bottleTagsChanged || folded.bottleTransitions.length > 0)) {
      stmts.push(
        `UPDATE packages SET latest_bottle_tags = ${sqlLit(JSON.stringify(folded.bottleTags))}, bottle_interval_count = (SELECT COUNT(*) FROM bottle_intervals bi WHERE bi.package_id = packages.id) WHERE ${where};`,
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
          ? `UPDATE packages SET removed_at = ${sqlLit(removed.at)}, removed_commit = ${sqlLit(removed.commit)}, renamed_to = ${sqlLit(removed.renamedTo)}, migrated_to = ${sqlLit(removed.migratedTo)} WHERE ${where};`
          : `UPDATE packages SET removed_at = NULL, removed_commit = NULL, renamed_to = NULL, migrated_to = NULL WHERE ${where};`,
      );
    }
  }
  if (contributorSeeded) {
    stmts.push(
      `UPDATE contributor_seeds SET seeded_at_sha = ${sqlLit(delta.head)} WHERE source = ${sqlLit(source.id)};`,
    );
  }
  stmts.push(cursorSql);
  // Wrangler sends --file imports through D1's atomic import API. Keep the cursor last
  // as an additional, observable invariant and so local/mock executors remain safe.
  d1Apply(mode, `${stmts.join("\n")}\n`);
  return { status: "ok", events, commits: delta.commits, head: delta.head };
}
