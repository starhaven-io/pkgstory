# pkgstory

<!-- fleet:block badges -->
[![CI](https://github.com/starhaven-io/pkgstory/actions/workflows/ci.yml/badge.svg)](https://github.com/starhaven-io/pkgstory/actions/workflows/ci.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg)](LICENSE)
[![Data: CC-BY-4.0](https://img.shields.io/badge/Data-CC--BY--4.0-green.svg)](data/LICENSE)
<!-- fleet:end -->

**Every package has a version story.** pkgstory mines a package manager's git
history into a browsable timeline — which version shipped, and when — for every
formula and cask. When a package is deprecated, disabled, renamed, migrated, or
dropped from the tap (like `terraform` after its BUSL relicense), it says so —
with the date and Homebrew's own reason or target — instead of trailing off at a
stale last version.

**Website:** [pkgstory.dev](https://pkgstory.dev)

The name: **pkg** + **story** — the version *story* of a package; **pkg**, not
*brew*, because it's built to outgrow Homebrew.

`brew log git` runs `git log` on one formula file, on your machine. pkgstory is
the layer that isn't there: commits deduped into real **version events**, casks
included with their own version semantics, the whole catalog searchable, and a
per-package RSS feed for each one. Repology answers *where* a package exists;
pkgstory answers *how its version has changed over time*. Homebrew is the first
source.

## How it works

Every Homebrew version bump is a commit to a single file (`Formula/g/git.rb`,
`Casks/v/visual-studio-code.rb`). The crawler turns that history into a
four-layer index, drawn so the expensive extraction happens exactly once:

- **L0 — commit index.** One streaming pass over git history records every
  commit that touched a package file, keyed by basename so Homebrew's historical
  file relocations don't matter. Stores each commit's `blob_sha`, so nothing
  downstream re-walks history.
- **L1 — snapshots.** The blob at each commit, parsed for `version`, `revision`,
  and the package's current `deprecate!`/`disable!` lifecycle. Lean today; richer
  fields (dependencies, bottles, patches) layer in later by re-reading the same
  blobs — no re-crawl.
- **L2 — version events.** Snapshots collapsed into the timeline: one row per
  `(version, revision)` change, so bottle rebuilds and metadata-only commits
  drop out. This is what the site renders.

A `git ls-tree` pass over `HEAD` after each crawl reconciles which packages still
exist in the tap. For absent packages, pkgstory consults the tap-root
`formula_renames.json`/`cask_renames.json` and `tap_migrations.json` files before
falling back to a plain deletion — so a rename or cross-tap migration is recorded
with its target instead of being described as removed entirely.

### Serving it

The site is an Astro app on Cloudflare Workers, sized so traffic can't run up
cost:

- **Per-package pages** read one package's rows from **D1** (SQLite at the edge)
  through an indexed query, behind an edge cache.
- **The home page and the search index** (`/packages.json`, ~20k entries) are
  precomputed into **Workers KV** by the crawler and served as a single lookup —
  independent of how much traffic arrives.

A GitHub Action re-crawls every 30 minutes: it derives the delta since the last
commit it saw, writes only the new version events to D1, and republishes the KV
blobs. A small Cloudflare Worker (`trigger/`) fires that schedule on a reliable
cron — GitHub's own `schedule:` trigger drops most fires. Deploys ship code, not
data, so the site stays current without a rebuild.

## Development

Requires Node 26+ (it runs the TypeScript directly — no build step) and, for
crawling, a local Homebrew clone (`homebrew/core` and/or `homebrew/cask`).

```sh
just install                                    # install dependencies
just crawl                                      # build pkgstory.db from a curated demo set
just crawl --formulae git,wget --casks firefox  # or specific packages
just crawl --all                                # the full catalog (~20k packages)
just site-seed-local                            # load pkgstory.db into local D1 + KV
just site-dev                                   # preview the site
just check                                      # everything CI runs
```

Run `just install-hooks` once per clone (DCO sign-off + pre-push checks). The
`crawl --d1 local|remote` mode writes deltas straight to Cloudflare D1 and
refreshes the KV cache — it's what the scheduled job runs.

<!-- fleet:block license-section -->
## License

Code is [AGPL-3.0-only](LICENSE). The version-history data, mined from public
git history, is [CC-BY-4.0](data/LICENSE).
<!-- fleet:end -->
