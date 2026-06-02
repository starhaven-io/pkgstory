# pkgstory

[![CI](https://github.com/starhaven-io/pkgstory/actions/workflows/ci.yml/badge.svg)](https://github.com/starhaven-io/pkgstory/actions/workflows/ci.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg)](LICENSE)

Version history for every package, mined from package-manager git history and browsable on the web.

`brew log git` runs `git log` on one formula file, on your machine. pkgstory is the layer that isn't there: commits deduped into real **version events**, casks included with their own version semantics, browsable across the whole ecosystem, with feeds. Think Repology, but for *time* — what changed, and when.

## How it works

The first source is Homebrew, where every version bump is a commit on a single file (`Formula/g/git.rb`, `Casks/v/visual-studio-code.rb`). The crawler turns that history into a SQLite index in four layers, drawn so the expensive work happens exactly once:

- **L0 — commit index.** One pass over git history records every commit that touched a package's file, keyed by basename so Homebrew's historical file relocations don't matter. It stores each commit's `blob_sha`, so nothing below ever has to re-walk history.
- **L1 — snapshots.** The file blob at each commit, parsed for `version` and `revision`. Lean today; richer fields (dependencies, bottles, patches) layer in here later by re-reading the same blobs — no re-crawl.
- **L2 — version events.** Snapshots collapsed into the timeline: one row per `(version, revision)` change, so bottle rebuilds and metadata commits drop out.
- **The site** reads that SQLite file at build time and renders per-package history pages, a "recent updates" feed, and RSS.

## Usage

Requires Node 26+ and a local Homebrew clone (`homebrew/core` and/or `homebrew/cask`).

```sh
just install        # install dependencies
just crawl          # build pkgstory.db from a curated demo set
just crawl --formulae git,wget,jq --casks firefox,iterm2
just site-dev       # preview the site against the index
```

Run `just check` before pushing (it mirrors CI). Enable the commit hooks once per clone with `just install-hooks`.

## Status

Early. The current crawl covers a curated package set as a working slice; scaling L0 to the full ~14k formulae + casks, the richer L1 fields, and notifications (per-package RSS is already there; email/push is the natural phase-2) are next.
