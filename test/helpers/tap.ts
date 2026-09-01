import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeSource, type Source } from "../../src/sources/index.ts";

// A throwaway git repo shaped like a tap. Config is isolated (GIT_CONFIG_GLOBAL=
// /dev/null) so a developer's gpgsign/hooksPath can't break fixture commits, and
// commit timestamps are explicit so ordering assertions are deterministic.
export const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "pkgstory-test",
  GIT_AUTHOR_EMAIL: "test@pkgstory.invalid",
  GIT_COMMITTER_NAME: "pkgstory-test",
  GIT_COMMITTER_EMAIL: "test@pkgstory.invalid",
};

export const T0 = 1750000000;

const cleanups: string[] = [];

/** Remove every fixture dir created by this module. Call from afterAll. */
export function cleanupFixtures(): void {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
  cleanups.length = 0;
}

/** Register an externally-created temp dir for cleanupFixtures to remove. */
export function trackFixture(dir: string): void {
  cleanups.push(dir);
}

export class TapRepo {
  readonly dir: string;
  readonly source: Source;
  private tick = 0;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "pkgstory-tap-"));
    cleanups.push(this.dir);
    this.git("init", "-q", "-b", "main");
    this.source = makeSource(
      {
        id: "homebrew-formula",
        label: "Test tap",
        tap: "test/tap",
        dir: "Formula",
        kind: "formula",
      },
      this.dir,
    );
  }

  git(...args: string[]): string {
    return execFileSync("git", ["-C", this.dir, ...args], {
      encoding: "utf8",
      env: {
        ...GIT_ENV,
        GIT_AUTHOR_DATE: `${this.at()} +0000`,
        GIT_COMMITTER_DATE: `${this.at()} +0000`,
      },
    }).trim();
  }

  write(path: string, content: string): void {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  /** Stage everything and commit at the next (or a pinned) timestamp. */
  commit(
    message: string,
    at?: number,
    author?: string,
    authorAt?: number,
  ): { sha: string; at: number } {
    this.tick += 1;
    if (at !== undefined) this.pinned = at;
    this.git("add", "-A");
    this.git(
      "commit",
      "-q",
      "-m",
      message,
      ...(author ? ["--author", author] : []),
      ...(authorAt === undefined ? [] : ["--date", `${authorAt} +0000`]),
    );
    const sha = this.git("rev-parse", "HEAD");
    const time = this.pinned ?? this.at();
    this.pinned = undefined;
    return { sha, at: time };
  }

  commitWithAuthorDate(
    message: string,
    authorAt: number,
    at?: number,
  ): { sha: string; at: number } {
    return this.commit(message, at, undefined, authorAt);
  }

  private pinned: number | undefined;
  private at(): number {
    return this.pinned ?? T0 + this.tick * 1000;
  }
}

export function fakeBrewBin(): string {
  const dir = mkdtempSync(join(tmpdir(), "pkgstory-brew-"));
  cleanups.push(dir);
  const brew = join(dir, "brew");
  writeFileSync(
    brew,
    `#!/bin/sh
if [ "$1" = "--repository" ] && [ "$2" = "homebrew/core" ]; then
  printf '%s\\n' "$PKGSTORY_TEST_TAP"
  exit 0
fi
exit 1
`,
  );
  chmodSync(brew, 0o755);
  return dir;
}

export function formula(name: string, version: string, extra = ""): string {
  const cls = (name[0] ?? "x").toUpperCase() + name.slice(1);
  return `class ${cls} < Formula\n  url "https://example.com/${name}-${version}.tar.gz"\n${extra}end\n`;
}
