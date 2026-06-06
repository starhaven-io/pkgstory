# pkgstory — Claude Project Context

pkgstory is a package version-history viewer. It mines git history of package
repositories (Homebrew first) into a SQLite index and renders browsable per-package
timelines, a recent-updates feed, and RSS. Repology answers "where does this package
exist"; pkgstory answers "how has its version changed over time."

## Project overview

- **Language:** TypeScript, run directly on Node 26 (native type stripping — no build step).
- **Storage:** SQLite via the built-in `node:sqlite` (no native dependency).
- **Site:** Astro + `@astrojs/cloudflare` on Cloudflare Workers. On-demand pages read
  D1 at runtime; catalog-wide reads (home page, search index) are served from
  precomputed KV blobs the crawler republishes each run, so no amount of traffic
  scans the catalog. No database is needed at build time.
- **License:** AGPL-3.0-only.
- **Lint/format:** Biome (`src/`), Prettier (`site/`), typos (repo-wide).

## Repository structure

```
pkgstory/
├── src/
│   ├── cli.ts                 # entry: `pkgstory crawl [--db] [--formulae] [--casks]`
│   ├── git.ts                 # git plumbing: logRaw (--raw pass), batchCat (cat-file --batch)
│   ├── sources/index.ts       # Source defs; path↔package mapping (basename-keyed)
│   ├── parse/{formula,cask,subject}.ts   # DSL version/revision extraction + subject fallback
│   ├── crawl/commit-index.ts  # L0
│   ├── crawl/snapshot.ts       # L1
│   ├── crawl/events.ts         # L2
│   └── db/{schema.sql,db.ts}   # node:sqlite schema + helpers
├── test/parse.test.ts         # vitest unit tests for the parsers
├── site/                      # Astro app on Workers; reads D1 + KV at runtime
└── justfile                   # build · test · lint · crawl · check · site-* · install-hooks
```

## Architecture

The four-layer index exists to make extraction (expensive, once) separable from
derivation (cheap, re-runnable):

- **L0 `commit_index`** — one `git log --raw --no-abbrev` pass per source, bucketed by
  file basename so historical relocations (`Library/Formula/` → `Formula/` →
  `Formula/g/`) need no `--follow`. Stores `blob_sha` (full 40-char) for every touch.
- **L1 `snapshots`** — parse the blob at each commit. Lean columns now (`version`,
  `revision`, `version_src`); rich columns are added here later, derived from the same
  stored `blob_sha`s with no history re-walk.
- **L2 `version_events`** — walk snapshots oldest→newest, emit a row only when
  `(version, revision)` changes. `introduced_at` is the version's first appearance.

Version derivation precedence: explicit `version` stanza → git `tag:` → mined from
`url` → commit-subject fallback (`<name> <version>`). `version_src` records which.

Lifecycle & removal (denormalized onto `packages`): L1 also captures the latest live
blob's `deprecate!`/`disable!` state into `lifecycle`/`lifecycle_date`/`lifecycle_reason`
(parser in `parse/lifecycle.ts`; disable outranks deprecate). After each crawl,
`crawl/removals.ts` reconciles against a `git ls-tree HEAD` present-set — a package
absent from the tap gets `removed_at`/`removed_commit` from its last commit. The
incremental paths surface both from the delta; a removal preserves the last captured
lifecycle (the "why"). The site shows a banner + a `removed`/`disabled`/`deprecated`
chip; the KV catalog/home blobs carry a compact `r`/`x`/`d` status code.

### Performance notes

- `batchCat` reads all of a source's blobs in one `git cat-file --batch` process. Use
  full shas (`--no-abbrev`) — `--batch` echoes the full oid in its header, so feeding
  abbreviated shas silently mismatches the result map.
- The slice scopes `git log` to specific package paths. The production L0 is a single
  unfiltered whole-tree pass bucketed by basename; for full scale, stream the log and
  `cat-file --batch` rather than buffering.

## Commit conventions

Conventional Commits: `type(scope): description` (feat, fix, docs, style, refactor,
perf, test, build, ci, chore). Every commit must:

- Sign off with `git commit -s` for DCO (enforced by `.githooks/commit-msg`; run
  `just install-hooks` once per clone).
- Carry `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` after
  the `Signed-off-by` trailer when authored with Claude.

## Git workflow

- Never commit directly to main — branch and open a PR.
- PR descriptions are a short prose summary only — no test-plan sections, no bot
  attribution footers.
