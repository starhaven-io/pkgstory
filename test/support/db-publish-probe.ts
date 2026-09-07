import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, openStagedDb } from "../../src/db/db.ts";

function packageNames(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT name FROM packages ORDER BY name").all() as { name: string }[]).map(
      ({ name }) => name,
    );
  } finally {
    db.close();
  }
}

async function captureError(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected action to throw");
}

async function probe(scenario: string): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "pkgstory-publish-probe-"));
  const target = join(dir, "crawl.db");
  try {
    const original = openDb(target);
    original.exec("INSERT INTO packages (source, name) VALUES ('homebrew-formula', 'old')");
    original.close();

    const staged = await openStagedDb(target);
    staged.db.exec("INSERT INTO packages (source, name) VALUES ('homebrew-formula', 'new')");
    const stagingDir = readdirSync(dir).find((name) => name.startsWith(".pkgstory-staging-"));
    if (!stagingDir) throw new Error("staging directory was not created");
    const retained = join(dir, stagingDir, basename(target));

    if (scenario === "stale-sidecars") {
      writeFileSync(`${target}-wal`, "");
      writeFileSync(`${target}-shm`, "");
      await staged.publish();
      const wal = existsSync(`${target}-wal`);
      const shm = existsSync(`${target}-shm`);
      return {
        names: packageNames(target),
        retained: existsSync(retained),
        wal,
        shm,
      };
    }

    if (scenario === "idle-read-only" || scenario === "idle-read-write") {
      let held: DatabaseSync | null =
        scenario === "idle-read-only"
          ? new DatabaseSync(target, { readOnly: true })
          : new DatabaseSync(target);
      try {
        held.prepare("SELECT COUNT(*) FROM packages").get();
        const walBytes = statSync(`${target}-wal`).size;
        const shmBytes = statSync(`${target}-shm`).size;
        const error = await captureError(() => staged.publish());
        const targetBeforeRetry = packageNames(target);
        const stageBeforeRetry = packageNames(retained);
        const retainedBeforeRetry = existsSync(retained);
        held.close();
        held = null;
        await staged.publish();
        return {
          error,
          walBytes,
          shmBytes,
          targetBeforeRetry,
          stageBeforeRetry,
          retainedBeforeRetry,
          targetAfterRetry: packageNames(target),
          retainedAfterRetry: existsSync(retained),
        };
      } finally {
        held?.close();
      }
    }

    if (scenario === "framed-wal") {
      let writer: DatabaseSync | null = new DatabaseSync(target);
      try {
        writer.exec("PRAGMA wal_autocheckpoint = 0");
        writer.exec("INSERT INTO packages (source, name) VALUES ('homebrew-formula', 'late')");
        const walBytes = statSync(`${target}-wal`).size;
        const error = await captureError(() => staged.publish());
        const retainedAfterFailure = existsSync(retained);
        writer.close();
        writer = null;
        return {
          error,
          walBytes,
          retainedAfterFailure,
          targetNames: packageNames(target),
          stagedNames: packageNames(retained),
        };
      } finally {
        writer?.close();
      }
    }

    if (scenario === "unopened-connection") {
      let held: DatabaseSync | null = new DatabaseSync(target);
      try {
        const walBefore = existsSync(`${target}-wal`);
        const shmBefore = existsSync(`${target}-shm`);
        await staged.publish();
        held.exec("INSERT INTO packages (source, name) VALUES ('homebrew-formula', 'late')");
        held.close();
        held = null;
        return { walBefore, shmBefore, names: packageNames(target) };
      } finally {
        held?.close();
      }
    }

    if (scenario === "backup-failure") {
      rmSync(target);
      mkdirSync(target);
      const error = await captureError(() => staged.publish());
      return { error, retained: existsSync(retained) };
    }

    throw new Error(`unknown probe scenario: ${scenario}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const scenario = process.argv[2];
if (!scenario) throw new Error("probe scenario is required");
console.log(JSON.stringify(await probe(scenario)));
