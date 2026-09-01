# Operations

Runbook for the deployed pkgstory pipeline (crawler → D1/KV → site).

## Freshness model

- The trigger Worker (`trigger/`) fires a `repository_dispatch` every 30
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
cursor is written last, so a failed apply does not acknowledge unapplied rows.

## Reseeding the deployed D1/KV

A reseed replaces the complete D1 site slice from a local full-crawl database:

```sh
just crawl --all
just site-seed-remote
```

Caveats:

- Remote D1 is unavailable while Wrangler applies the import. A successful
  import exposes the new slice; if the import fails, Wrangler restores the
  original database.
- Seed only from a `crawl --all` database. An incremental-only database has no
  complete contributor history, and `contributor_seeds` intentionally lands
  last so a partial import cannot enable incremental contributor writes on top
  of an incomplete seed.
- After deploying per-platform bottle history to an existing D1 database, run a
  full crawl and remote reseed before relying on bottle intervals. The schema
  migration can establish current tags and boundary versions on future touches,
  but it cannot infer when an existing tag first appeared or annotate older
  intervals for same-release coalescing. The same ambiguity can occur if a
  non-transactional D1 apply stops after inserting a brand-new package row but
  before its initial interval. Already-applied transitions are safe to replay;
  retrying establishes the correct current state, while a full reseed restores
  the missing historical interval.
- `just site-seed-local` runs the same procedure against local D1/KV for site
  testing.

## Manual cache rebuild

`node src/cli.ts cache --d1 local|remote` rebuilds the KV `catalog` and `home`
blobs from D1. The target is required; there is no default.

A manual rebuild always recomputes the home-page spotlight, which is appropriate
after a reseed. Scheduled crawls reuse the published spotlight until it is 23
hours old.
