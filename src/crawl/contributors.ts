import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { ContributorAttribution } from "../contributors.ts";
import { commitAttributions } from "../contributors.ts";
import { headSha, type RawCommit } from "../git.ts";
import type { Source } from "../sources/index.ts";

export interface ContributorWriter {
  link(packageId: number, commit: RawCommit): void;
  linkAttributions(
    packageId: number,
    commitSha: string,
    committedAt: number,
    attributions: ContributorAttribution[],
  ): void;
}

function writeAttributions(
  upsert: StatementSync,
  link: StatementSync,
  latestWritten: Map<string, number>,
  packageId: number,
  commitSha: string,
  committedAt: number,
  attributions: ContributorAttribution[],
): void {
  for (const contributor of attributions) {
    const prior = latestWritten.get(contributor.key);
    if (prior === undefined || committedAt > prior) {
      upsert.run(
        contributor.key,
        contributor.displayName,
        contributor.githubLogin,
        contributor.isBot ? 1 : 0,
        committedAt,
      );
      latestWritten.set(contributor.key, committedAt);
    }
    link.run(packageId, commitSha, contributor.key, contributor.role);
  }
}

export function contributorWriter(db: DatabaseSync): ContributorWriter {
  const latestWritten = new Map<string, number>();
  const upsert = db.prepare(
    `INSERT INTO contributors (contributor_key, display_name, github_login, is_bot, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (contributor_key) DO UPDATE SET
       display_name = excluded.display_name,
       github_login = excluded.github_login,
       is_bot = excluded.is_bot,
       last_seen_at = excluded.last_seen_at
     WHERE excluded.last_seen_at >= contributors.last_seen_at`,
  );
  const link = db.prepare(
    `INSERT OR IGNORE INTO commit_contributors
       (package_id, commit_sha, contributor_key, role)
     VALUES (?, ?, ?, ?)`,
  );

  return {
    link(packageId, commit): void {
      writeAttributions(
        upsert,
        link,
        latestWritten,
        packageId,
        commit.sha,
        commit.committedAt,
        commitAttributions(commit),
      );
    },
    linkAttributions(packageId, commitSha, committedAt, attributions): void {
      writeAttributions(
        upsert,
        link,
        latestWritten,
        packageId,
        commitSha,
        committedAt,
        attributions,
      );
    },
  };
}

const INSERT_AGGREGATES = `INSERT INTO package_contributors
  (package_id, contributor_key, touch_count, version_count, first_at, last_at)
SELECT cc.package_id,
       cc.contributor_key,
       COUNT(DISTINCT cc.commit_sha),
       COUNT(DISTINCT CASE WHEN vc.commit_sha IS NOT NULL THEN cc.commit_sha END),
       MIN(ci.committed_at),
       MAX(ci.committed_at)
  FROM commit_contributors cc
  JOIN commit_index ci
    ON ci.package_id = cc.package_id AND ci.commit_sha = cc.commit_sha
  LEFT JOIN version_changes vc
    ON vc.package_id = cc.package_id AND vc.commit_sha = cc.commit_sha`;

export function rebuildPackageContributors(db: DatabaseSync, packageIds: number[]): number {
  const remove = db.prepare("DELETE FROM package_contributors WHERE package_id = ?");
  const insert = db.prepare(
    `${INSERT_AGGREGATES} WHERE cc.package_id = ? GROUP BY cc.contributor_key`,
  );
  let rows = 0;
  for (const packageId of new Set(packageIds)) {
    remove.run(packageId);
    rows += Number(insert.run(packageId).changes);
  }
  return rows;
}

export function buildPackageContributors(
  db: DatabaseSync,
  source: Source,
  names?: string[],
): number {
  if (names) {
    const getPackage = db.prepare("SELECT id FROM packages WHERE source = ? AND name = ?");
    const ids = names.flatMap((name) => {
      const row = getPackage.get(source.id, name) as { id: number } | undefined;
      return row ? [row.id] : [];
    });
    db.exec("BEGIN");
    const rows = rebuildPackageContributors(db, ids);
    db.exec("COMMIT");
    return rows;
  }

  const seedSha = headSha(source.repoDir);
  db.exec("BEGIN");
  db.prepare(
    `DELETE FROM package_contributors
      WHERE package_id IN (SELECT id FROM packages WHERE source = ?)`,
  ).run(source.id);
  const result = db
    .prepare(
      `${INSERT_AGGREGATES}
        JOIN packages p ON p.id = cc.package_id
       WHERE p.source = ?
       GROUP BY cc.package_id, cc.contributor_key`,
    )
    .run(source.id);
  db.prepare(
    `INSERT INTO contributor_seeds (source, seeded_at_sha) VALUES (?, ?)
     ON CONFLICT (source) DO UPDATE SET seeded_at_sha = excluded.seeded_at_sha`,
  ).run(source.id, seedSha);
  db.exec("COMMIT");
  return Number(result.changes);
}
