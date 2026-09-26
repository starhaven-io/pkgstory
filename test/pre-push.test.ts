import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { cleanupFixtures, GIT_ENV, TapRepo, trackFixture } from "./helpers/tap.ts";

afterAll(cleanupFixtures);

it("keeps fixture Git operations out of the repository invoking pre-push", () => {
  const tap = new TapRepo();
  tap.write("README", "fixture\n");
  const { sha } = tap.commit("fixture");
  const bin = mkdtempSync(join(tmpdir(), "pkgstory-hook-"));
  trackFixture(bin);
  const foreign = join(bin, "foreign.git");
  const just = join(bin, "just");
  writeFileSync(
    just,
    '#!/bin/sh\nset -eu\ntest "$1" = check\ngit init --bare --quiet "$PKGSTORY_HOOK_FOREIGN_REPO"\n',
  );
  chmodSync(just, 0o755);
  const gitDir = join(tap.dir, ".git");
  const config = readFileSync(join(gitDir, "config"), "utf8");

  execFileSync(fileURLToPath(new URL("../.githooks/pre-push", import.meta.url)), [], {
    cwd: tap.dir,
    input: `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
    env: {
      ...GIT_ENV,
      GIT_DIR: gitDir,
      GIT_COMMON_DIR: gitDir,
      GIT_INDEX_FILE: join(gitDir, "index"),
      PATH: `${bin}:${process.env.PATH}`,
      PKGSTORY_HOOK_FOREIGN_REPO: foreign,
    },
  });

  expect(existsSync(join(foreign, "HEAD"))).toBe(true);
  expect(readFileSync(join(gitDir, "config"), "utf8")).toBe(config);
});
