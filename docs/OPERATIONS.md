# Operations

Runbook for the deployed pkgstory pipeline (crawler → D1/KV → site).

## Code deployment

Main-branch changes to `site/` redeploy the site Worker. The two trigger Workers
have separate deployment workflows: each configuration redeploys its own Worker,
while shared trigger source and dependency changes redeploy both.
Each deployment also runs when its workflow or the shared npm-policy checker
changes. Deployment and crawl dispatches require `main`; rejected refs use
separate concurrency groups so they cannot cancel or replace pending production
work. Site and trigger deployments retain separate queues, and a new crawl never
interrupts an active D1 write.

## Freshness model

- The trigger Worker fires `workflow_dispatch` on the cron defined in
  [`trigger/wrangler.jsonc`](../trigger/wrangler.jsonc); `crawl.yml` runs
  `pkgstory crawl --d1 remote`, which writes the delta to D1 and republishes the KV blobs.
- Every crawl, including an up-to-date one, advances that source's
  `crawl_state.last_crawled_at` heartbeat after that source succeeds. A missing D1
  cursor fails the run and requires seeding; it is not a successful empty crawl.
- A failing source does not block the other source or the KV refresh; the run
  still fails, and the failed source's cursor and heartbeat stay where they were.
- The Workers Cache serves each route for up to its `s-maxage`: ten to fifteen
  minutes for pages, JSON, and feeds, an hour for badges and the sitemap. A crawl's changes can
  take that long to appear. `/health.json` is never cached, and each site deploy
  starts with a cold cache.
- <https://pkgstory.dev/health.json> reports each expected source and serves
  HTTP 503 when either source is missing or more than two hours stale. Its
  top-level fields report the worst source.

## When the crawl is stale

A failed `crawl.yml` run files or appends to a GitHub Actions-authored
`Crawl workflow failing` issue, with a link to the failed run. The next
successful run closes any such open issues automatically.

The separate `pkgstory-monitor-trigger` Cloudflare Worker dispatches
`check-crawl-dispatch.yml` hourly at :11 UTC. The workflow retains its hourly
GitHub schedule as a fallback. It looks for a bot-created `starhaven-bot` dispatch
created on `main` in the past two hours. It maintains a
separate `Hourly crawl dispatches are missing` issue; a fallback crawl or a rerun
of an old dispatch cannot close it. An unreadable run list reports unknown
health and keeps the alert open. Recovery requires a recent qualifying dispatch,
including queued, running, failed or cancelled crawls. Crawl success is tracked
by the separate crawl-failure issue.

The check fetches unfiltered workflow-run pages, newest first, until it finds a
qualifying dispatch, passes the two-hour window, or exhausts the list. It checks
actor, branch, event, workflow, and age locally: filtered API queries have
transiently omitted qualifying runs. Job logs report whether dispatches are
healthy, missing, or unreadable, including errors reading or validating the list.

The monitor Worker has its own cron, secret binding, and deployment workflow;
it runs even when the crawl Worker is disabled or its configuration is broken.
Both still depend on Cloudflare and the starhaven-bot App's access to GitHub.
The GitHub fallback uses `GITHUB_TOKEN` and can still alert on missing crawl
dispatches during Cloudflare cron or App access failures, but its scheduling
delays can postpone alerts by hours. An external `/health.json` monitor is needed
for timely detection of stale crawls and coverage during GitHub outages; verify
it using the [external control checklist](#external-control-checklist). There is
no separate alert when the monitor Worker stops dispatching; checks quietly fall
back to GitHub's schedule. See
[trigger setup and verification](../trigger/README.md) for provisioning the new
Worker's secret and confirming successive scheduled dispatches.

Triage in this order:

1. Check `/health.json` to identify which source is stale and since when.
2. Check the [crawl workflow runs](https://github.com/starhaven-io/pkgstory/actions/workflows/crawl.yml).
   Failed runs indicate a crawler, tap, or Wrangler problem; no recent runs
   indicate that the trigger is not dispatching.
3. Inspect trigger Worker logs with `cd trigger && npx wrangler tail`.
   Dispatch failures are logged and rethrown, so they appear as errored
   invocations in Cloudflare observability.
4. If dispatch checks themselves are missing, inspect the monitor Worker with
   `cd trigger && npx wrangler tail --config wrangler.monitor.jsonc`. Confirm its
   cron is enabled and its separate `APP_PRIVATE_KEY` secret is configured.

The next successful crawl derives everything since the stored cursor. The
remote SQL file is an atomic D1 import, and the cursor is also written last as
an observable defense-in-depth invariant.

Every D1 write is conditional on the cursor the crawl read. A crawl that overlaps
another writer applies nothing and fails with `D1 cursor moved` or, from the
import, `NOT NULL constraint failed: crawl_state.last_crawled_at`; the next run
continues from the new cursor.

## Reseeding the deployed D1/KV

A reseed replaces the complete D1 site slice from a local full-crawl database.
Stop every other D1 writer before seeding: disabling `crawl.yml` stops trigger
dispatches (the Worker logs errors meanwhile), the fallback schedule, and pushes.
Wait until no crawl run is queued or in progress, and do not run
`crawl --d1 remote` by hand until the workflow is enabled again.

```sh
just crawl --all
gh workflow disable crawl.yml
gh run list --workflow crawl.yml --limit 5
just site-seed-remote
gh workflow enable crawl.yml
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
  crawl and remote reseed. A cursor outside the current Git ancestry also requires
  rebuilding and reseeding. Existing D1 event and interval rows are precomputed;
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
hours old, while refreshing each card's current version and lifecycle on every
cache publication.

## External control checklist

These controls are not established by repository files and must be verified in
their respective control planes:

- Dispatch requires **starhaven-bot** to have **Actions: Read and write**, with
  the corresponding permission grant accepted on its repository installation. Keep its
  repository-content and pull-request permissions needed by other consumers.
  Before rotating a key, inventory its consumers, including the fleet sync in
  `dot_github`, update each consumer and verify it works before revocation.
  Checked-in configuration does not verify equality of hosted secret values.
- Require the aggregate CI conclusion on the current revision. Keep approval
  settings aligned with the single-maintainer operating model in the infrastructure
  control plane.
- Monitor `/health.json` from outside GitHub Actions and alert on HTTP 503. The
  workflow's issue automation detects failed runs, but cannot detect every case
  where scheduling stops entirely.
