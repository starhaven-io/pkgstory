# Operations

Runbook for the deployed pkgstory pipeline (crawler → D1/KV → site).

## Freshness model

- The trigger Worker (`trigger/`) fires a `workflow_dispatch` every 30
  minutes; `crawl.yml` runs `pkgstory crawl --d1 remote`, which writes the
  delta to D1 and republishes the KV blobs.
- Every crawl, including an up-to-date one, advances that source's
  `crawl_state.last_crawled_at` heartbeat.
- <https://pkgstory.dev/health.json> reports each expected source and serves
  HTTP 503 when either source is missing or more than two hours stale. Its
  top-level fields report the worst source.

## When the crawl is stale

A failed `crawl.yml` run files or appends to a GitHub Actions-authored
`Crawl workflow failing` issue, with a link to the failed run. The next
successful run closes any such open issues automatically.

Triage in this order:

1. Check `/health.json` to identify which source is stale and since when.
2. Check the [crawl workflow runs](https://github.com/starhaven-io/pkgstory/actions/workflows/crawl.yml).
   Failed runs indicate a crawler, tap, or Wrangler problem; no recent runs
   indicate that the trigger is not dispatching.
3. Inspect trigger Worker logs with `cd trigger && npx wrangler tail`.
   Dispatch failures are logged and rethrown, so they appear as errored
   invocations in Cloudflare observability.

The next successful crawl derives everything since the stored cursor. The
remote SQL file is an atomic D1 import, and the cursor is also written last as
an observable defense-in-depth invariant.

## Reseeding the deployed D1/KV

A reseed replaces the complete D1 site slice from a local full-crawl database:

```sh
just crawl --all
just site-seed-remote
```

`crawl --all` pins one tap commit per source and rebuilds against a private copy
of the local database. It atomically replaces the requested database only after
every source succeeds, so an interrupted or failed crawl leaves the last good
seed untouched. Handled crawl failures remove their staging directory. If final
publication is unsafe or SQLite's transactional backup fails, the completed
database is retained and the error names its exact path. An abrupt process
termination can also leave an ignored `.pkgstory-staging-*` directory beside
the database; remove one only after confirming no full crawl is running.

Before replacement, publication refuses a target WAL containing data. It asks
SQLite to clean up a stale `-shm` or zero-byte `-wal`, but refuses publication if
either sidecar remains because a live reader and an idle writer are not safely
distinguishable. Close all target readers and writers, checkpoint the target,
and confirm its sidecars are gone. Publish the retained database named in the
error through SQLite's backup API, for example by opening it with `sqlite3` and
using `.backup` with the target path. Do not rename a SQLite database over an
open target, and never delete an active sidecar.

Caveats:

- Budget peak local disk usage at roughly three times the final database size
  during full-crawl publication because the old target, staged copy, and publish
  WAL can coexist.
- Remote D1 is unavailable while Wrangler applies the import. A successful
  import exposes the new slice; if the import fails, Wrangler restores the
  original database.
- Seed only from a `crawl --all` database. An incremental-only database has no
  complete contributor history, and `contributor_seeds` intentionally lands
  last as defense in depth for local and test importers. Export opens its input
  read-only and refuses a stale schema rather than migrating production seed
  material as a side effect.
- Changes to history ordering or commit timestamp semantics require a new full
  crawl and remote reseed. Existing D1 event and interval rows are precomputed;
  an incremental crawl cannot rewrite their historical boundaries.
- The `version_changes` table preserves reverts for RSS and recent updates.
  Its online migration backfills canonical introductions only; run a full crawl
  and reseed once after deploying it to recover older revert transitions.
- Corrections to package-path filtering and formula metadata extraction require
  that same full crawl and reseed. For this rollout, it removes legacy fixture
  or decoy paths that older crawls indexed and restores versions from historical
  `stable do` URL/tag stanzas; incremental crawling cannot repair untouched rows.
- Prepare and apply the full reseed before allowing the updated scheduled crawler
  to run against an existing large D1 database. The first online
  `version_changes` backfill is intentionally a compatibility path, not the
  production rollout plan, and can exceed D1's statement time limit on a large
  catalog.
- After deploying per-platform bottle history to an existing D1 database, run a
  full crawl and remote reseed before relying on bottle intervals. The schema
  migration can establish current tags and boundary versions on future touches,
  but it cannot infer when an existing tag first appeared or annotate older
  intervals for same-release coalescing. Wrangler applies each remote `--file`
  import atomically; a failed import restores the prior database.
- `just site-seed-local` runs the same procedure against local D1/KV for site
  testing.

## Manual cache rebuild

`node src/cli.ts cache --d1 local|remote` rebuilds the KV `catalog`, `home`, and
`sitemap` blobs from D1. The target is required; there is no default.

A manual rebuild always recomputes the home-page spotlight, which is appropriate
after a reseed. Scheduled crawls reuse the published spotlight until it is 23
hours old.

## External control checklist

These controls are not established by repository files and must be verified in
their respective control planes:

- Grant the dedicated crawl GitHub App **Actions: Read and write** for `pkgstory`
  before deploying the workflow-dispatch trigger. Confirm one successful
  dispatch, then remove repository-content write access and rotate the Worker
  private key. Reversing this order can stop scheduled crawls.
- Require the aggregate CI conclusion and dismiss stale pull-request approvals
  when reviewable code changes.
- Monitor `/health.json` from outside GitHub Actions and alert on HTTP 503. The
  workflow's issue automation detects failed runs, but cannot detect every case
  where scheduling stops entirely.
