import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.ts";

function publishProbe(scenario: string): Record<string, unknown> {
  const probe = fileURLToPath(new URL("./support/db-publish-probe.ts", import.meta.url));
  return JSON.parse(execFileSync(process.execPath, [probe, scenario], { encoding: "utf8" }));
}

describe("database lifecycle", () => {
  it("cleans stale empty sidecars before publishing", () => {
    expect(publishProbe("stale-sidecars")).toEqual({
      names: ["new", "old"],
      retained: false,
      wal: false,
      shm: false,
    });
  });

  it.each(["idle-read-only", "idle-read-write"])(
    "preserves and retries a completed stage blocked by %s",
    (scenario) => {
      const result = publishProbe(scenario) as {
        error: string;
        walBytes: number;
        shmBytes: number;
        targetBeforeRetry: string[];
        stageBeforeRetry: string[];
        retainedBeforeRetry: boolean;
        targetAfterRetry: string[];
        retainedAfterRetry: boolean;
      };
      expect(result.error).toContain("completed staged database retained at");
      expect(result.walBytes).toBe(0);
      expect(result.shmBytes).toBeGreaterThan(0);
      expect(result.targetBeforeRetry).toEqual(["old"]);
      expect(result.stageBeforeRetry).toEqual(["new", "old"]);
      expect(result.retainedBeforeRetry).toBe(true);
      expect(result.targetAfterRetry).toEqual(["new", "old"]);
      expect(result.retainedAfterRetry).toBe(false);
    },
  );

  it("preserves a completed stage while the target WAL contains frames", () => {
    const result = publishProbe("framed-wal") as {
      error: string;
      walBytes: number;
      retainedAfterFailure: boolean;
      targetNames: string[];
      stagedNames: string[];
    };
    expect(result.error).toContain("completed staged database retained at");
    expect(result.walBytes).toBeGreaterThan(0);
    expect(result.retainedAfterFailure).toBe(true);
    expect(result.targetNames).toEqual(["late", "old"]);
    expect(result.stagedNames).toEqual(["new", "old"]);
  });

  it("publishes safely when an unopened connection already holds the target", () => {
    expect(publishProbe("unopened-connection")).toEqual({
      walBefore: false,
      shmBefore: false,
      names: ["late", "new", "old"],
    });
  });

  it("preserves a completed stage when the transactional backup fails", () => {
    const result = publishProbe("backup-failure") as { error: string; retained: boolean };
    expect(result.error).toContain("failed to publish");
    expect(result.error).toContain("completed staged database retained at");
    expect(result.retained).toBe(true);
  });

  it("rolls back every schema alteration when recovery fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "pkgstory-migration-"));
    const path = join(dir, "legacy.db");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE packages (
          id INTEGER PRIMARY KEY,
          source TEXT NOT NULL,
          name TEXT NOT NULL,
          UNIQUE (source, name)
        );
        CREATE TABLE commit_index (
          id INTEGER PRIMARY KEY,
          package_id INTEGER NOT NULL,
          commit_sha TEXT NOT NULL,
          blob_sha TEXT NOT NULL,
          committed_at INTEGER NOT NULL,
          UNIQUE (package_id, commit_sha)
        );
        CREATE TABLE version_events (
          id INTEGER PRIMARY KEY,
          package_id INTEGER NOT NULL,
          version TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          introduced_at INTEGER NOT NULL,
          commit_sha TEXT,
          subject TEXT,
          UNIQUE (package_id, version, revision)
        );
        CREATE TABLE version_changes (
          package_id INTEGER NOT NULL,
          commit_sha TEXT NOT NULL,
          PRIMARY KEY (package_id, commit_sha)
        );
        INSERT INTO packages (id, source, name)
        VALUES (1, 'homebrew-formula', 'foo');
        INSERT INTO commit_index (package_id, commit_sha, blob_sha, committed_at)
        VALUES (1, '${"a".repeat(40)}', '${"b".repeat(40)}', 1700000000);
        INSERT INTO version_events
          (package_id, version, revision, introduced_at, commit_sha, subject)
        VALUES (1, '1.0', 0, 1700000000, '${"a".repeat(40)}', 'foo 1.0');
        INSERT INTO version_changes (package_id, commit_sha)
        VALUES (1, '${"a".repeat(40)}');
        CREATE TRIGGER reject_recovery
        BEFORE UPDATE ON version_changes BEGIN
          SELECT RAISE(ABORT, 'forced migration failure');
        END;
      `);
      legacy.close();

      expect(() => openDb(path)).toThrow(/forced migration failure/);

      const inspected = new DatabaseSync(path, { readOnly: true });
      const columns = inspected.prepare("PRAGMA table_info(version_changes)").all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toEqual(["package_id", "commit_sha"]);
      inspected.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("indexes contributor identity for orphan cleanup", () => {
    const db = openDb(":memory:");
    const indexes = db.prepare("PRAGMA index_list(commit_contributors)").all() as Array<{
      name: string;
    }>;
    expect(indexes.map((index) => index.name)).toContain("idx_commit_contributors_key");
    db.close();
  });
});
