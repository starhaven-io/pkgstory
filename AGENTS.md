# Agent Instructions for pkgstory

Most importantly, run `just check` to verify file edits before handing work back,
unless the change is documentation-only and the narrower formatter/spellcheck
commands are enough.

## Project overview

pkgstory is a package version-history viewer. It mines package-manager git
history into a SQLite index and renders browsable per-package timelines, a
recent-updates feed, and RSS. Repology answers "where does this package exist";
pkgstory answers "how has its version changed over time."

This is a TypeScript repository run directly on Node 26 with native type
stripping. There is no build step for the CLI. Storage is SQLite via
`node:sqlite`; the site is Astro on Cloudflare Workers, with D1 for per-package
runtime reads and precomputed KV blobs for catalog-wide reads.

Licensed AGPL-3.0-only. Formatting and linting are split by area: Biome covers
the repo outside `site/`, Prettier covers `site/`, and typos runs repo-wide.

## Required checks

### Local verification

- Run `just check` for the full local gate: typecheck, tests, lint, formatting,
  typos, and site checks.
- For focused CLI/parser changes, run `just test` and `just build` before the
  broader gate.
- For focused site changes, run `just site-build` and `just site-format-check`
  before the broader gate.
- For formatting-only work, use `just format`, or `just site-format` for
  `site/`.
- Run `just install-hooks` once per clone so DCO sign-off and pre-push checks are
  active.

### Development flow

- Prefer the repo's existing TypeScript style and keep code runnable directly on
  Node 26.
- Keep extraction and derivation separated: expensive git history work belongs in
  L0/L1, while cheap recomputation belongs in L2 or later layers.
- Use full 40-character blob SHAs from `git log --raw --no-abbrev`; abbreviated
  SHAs break `git cat-file --batch` result matching.
- Add focused tests for parser, lifecycle, removal, database, and site behavior
  when changing those paths.
- Keep comments sparse; prefer clear names and structure unless a short comment
  explains non-obvious git, SQLite, or Cloudflare behavior.
- Preserve deployment economics: catalog-wide pages should use precomputed KV
  blobs, not per-request D1 catalog scans.

## Repository structure

- `src/cli.ts`: CLI entry point for `pkgstory crawl`.
- `src/git.ts`: git plumbing, including `logRaw` and `batchCat`.
- `src/sources/index.ts`: source definitions and path-to-package mapping.
- `src/parse/`: Homebrew formula/cask parsing, lifecycle parsing, and commit
  subject fallback logic.
- `src/crawl/commit-index.ts`: L0 commit index construction.
- `src/crawl/snapshot.ts`: L1 blob parsing and package snapshot construction.
- `src/crawl/events.ts`: L2 version-event derivation.
- `src/crawl/removals.ts`: HEAD present-set reconciliation and removal metadata.
- `src/db/`: SQLite schema and helpers.
- `test/`: Vitest coverage for parsers and crawl behavior.
- `site/`: Astro app deployed to Cloudflare Workers.
- `trigger/`: Small Cloudflare Worker that reliably triggers scheduled crawls.
- `justfile`: canonical local command surface.

## Project-specific notes

The index has three persisted derivation layers:

- L0 `commit_index`: one git history pass per source, bucketed by file basename
  so historical relocations do not require `--follow`.
- L1 `snapshots`: parse the blob at each touched commit into lean package state:
  `version`, `revision`, `version_src`, and latest live lifecycle metadata.
- L2 `version_events`: walk snapshots oldest to newest and emit a row only when
  `(version, revision)` changes.

Version derivation precedence is explicit `version` stanza, then git `tag:`,
then mined `url`, then commit-subject fallback (`<name> <version>`). The
`version_src` column records which source won.

Lifecycle and removal state is denormalized onto `packages`. `disable!` outranks
`deprecate!`; removals are reconciled against `git ls-tree HEAD` and preserve the
last captured lifecycle so the site can explain why a package disappeared.

Absent packages are further classified as renamed or migrated from the tap-root
`formula_renames.json`/`cask_renames.json` and `tap_migrations.json` files, read
at HEAD (the same ref as the `ls-tree` check). Same-tap `renamed_to` outranks
cross-tap `migrated_to` when a name appears in both. The incremental D1 crawl only
reclassifies packages touched in the current window, so rows removed before this
support existed stay plain-removed until a full crawl plus export/import reseed
backfills them.

## Safety / do-not-touch rules

1. Keep diffs focused and avoid unrelated refactors.
2. Use structured parsers and existing helpers rather than ad hoc string
   manipulation when the codebase already provides a parser boundary.
3. Do not introduce native SQLite dependencies; use `node:sqlite`.
4. Avoid request-time catalog scans in the site. Use KV blobs for catalog-wide
   data and indexed D1 queries for per-package data.
5. Keep GitHub Actions permissions explicit and minimal, especially for
   scheduled crawls and Cloudflare deploys.
6. Treat crawled upstream repository contents as untrusted input. Do not execute
   package DSL files; parse them as text.
7. Maintain incremental-crawl correctness: every optimization must preserve
   deletion detection, path relocation handling, and blob-SHA based re-derivation.
8. Keep README and operational docs current when changing command names,
   deployment behavior, or data semantics.

## Commit and PR conventions

- Use Conventional Commits: `type(scope): description`, with types such as
  `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, and
  `chore`.
- Sign off commits with `git commit -s`; DCO is enforced by
  `.githooks/commit-msg`.
- When authored with an AI coding agent, add a `Co-Authored-By` trailer after
  `Signed-off-by`, naming the agent and model. Current examples:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` or
  `Co-Authored-By: Codex GPT-5 <noreply@openai.com>`. Bump the model version as
  newer ones ship.
- Never commit directly to `main`; create a branch and open a PR.
- PR descriptions should be a short prose summary only, with no test-plan
  sections and no bot attribution or generated-with footers.
