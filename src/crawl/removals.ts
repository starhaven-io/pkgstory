import type { DatabaseSync } from "node:sqlite";
import { presentPackages } from "../git.ts";
import type { Source } from "../sources/index.ts";

/**
 * Flag packages whose file is gone from the tap at HEAD. The present-at-HEAD set is
 * authoritative (relocation-proof); for each absent package, its latest commit_index
 * row is the deletion, giving removed_at + the removing commit. Idempotent, and it
 * clears the flag if a package is later re-added. Runs after L0–L2 on a full crawl.
 */
export function reconcileRemovals(db: DatabaseSync, source: Source): number {
  const present = presentPackages(source.repoDir, source.dir, source.packageOf);
  const replacements = source.packageReplacements();

  db.exec("CREATE TEMP TABLE IF NOT EXISTS _present (name TEXT PRIMARY KEY)");
  db.exec(
    "CREATE TEMP TABLE IF NOT EXISTS _replacement (name TEXT PRIMARY KEY, renamed_to TEXT, migrated_to TEXT)",
  );
  db.exec("DELETE FROM _present");
  db.exec("DELETE FROM _replacement");
  const ins = db.prepare("INSERT OR IGNORE INTO _present (name) VALUES (?)");
  const insReplacement = db.prepare(
    "INSERT OR REPLACE INTO _replacement (name, renamed_to, migrated_to) VALUES (?, ?, ?)",
  );
  db.exec("BEGIN");
  for (const name of present) ins.run(name);
  for (const [name, replacement] of replacements) {
    insReplacement.run(name, replacement.renamedTo, replacement.migratedTo);
  }
  db.exec("COMMIT");

  const removed = Number(
    db
      .prepare(
        `UPDATE packages
            SET removed_at = (SELECT committed_at FROM commit_index ci
                               WHERE ci.package_id = packages.id
                               ORDER BY committed_at DESC, id DESC LIMIT 1),
                removed_commit = (SELECT commit_sha FROM commit_index ci
                                   WHERE ci.package_id = packages.id
                                   ORDER BY committed_at DESC, id DESC LIMIT 1)
          WHERE source = ? AND removed_at IS NULL
            AND name NOT IN (SELECT name FROM _present)`,
      )
      .run(source.id).changes,
  );

  db.prepare(
    `UPDATE packages
        SET renamed_to = (SELECT renamed_to FROM _replacement r WHERE r.name = packages.name),
            migrated_to = (SELECT migrated_to FROM _replacement r WHERE r.name = packages.name)
      WHERE source = ? AND name NOT IN (SELECT name FROM _present)`,
  ).run(source.id);

  // Reinstated: a previously-removed package that's present again.
  db.prepare(
    `UPDATE packages
        SET removed_at = NULL, removed_commit = NULL, renamed_to = NULL, migrated_to = NULL
      WHERE source = ?
        AND (removed_at IS NOT NULL OR renamed_to IS NOT NULL OR migrated_to IS NOT NULL)
        AND name IN (SELECT name FROM _present)`,
  ).run(source.id);

  db.exec("DROP TABLE _present");
  db.exec("DROP TABLE _replacement");
  return removed;
}
