# crawl-trigger

A Cloudflare Worker whose only job is a reliable cron. It fires every 30 minutes
and triggers the [`Crawl`](../.github/workflows/crawl.yml) GitHub Action by sending
a `repository_dispatch` event as the **starhaven-bot** GitHub App.

## Why

GitHub Actions' `schedule:` trigger is best-effort — under load it silently delays
and drops most fires, so the every-30-min crawl regularly drifted several hours
stale. Cloudflare's cron triggers don't get dropped. The crawl itself still runs on
GitHub (it needs full Homebrew tap clones and the Node crawler); this Worker just
pulls the trigger on a dependable schedule. `crawl.yml` keeps a coarse `schedule:`
only as a fallback for when this Worker is down.

## How it authenticates

Each tick the Worker signs a short-lived JWT with the App's private key, looks up
the App's installation on `pkgstory`, and mints a single-repo installation token
scoped to just `contents: write` (~1h TTL). `repository_dispatch` needs only
`contents: write`, which starhaven-bot already has — no App permission changes. The
App ID (`3331849`) is non-secret and lives in `wrangler.jsonc`; only the private key
is a secret.

## One-time setup

1. Make sure **starhaven-bot** is installed on the `pkgstory` repo (it is if the App
   shows `contents: write` for it — that's all `repository_dispatch` requires).
2. Get the App's private key (`.pem`) from its settings — *Generate a private key* if
   you don't have it saved. GitHub issues it in PKCS#1; WebCrypto needs PKCS#8, so
   convert it once:
   ```sh
   openssl pkcs8 -topk8 -nocrypt \
     -in starhaven-bot.private-key.pem -out starhaven-bot.pk8.pem
   ```
3. Deploy the Worker so the script exists, then store the key as a secret:
   ```sh
   cd trigger
   npm ci --strict-allow-scripts
   npm run deploy
   npx wrangler secret put APP_PRIVATE_KEY < starhaven-bot.pk8.pem
   ```
   The trigger explicitly denies its current dependency install scripts; run
   `just npm-policy` from the repository root after dependency changes.
   Until the secret is set, scheduled fires error (visible in `npx wrangler tail`).
   Once set, it persists across redeploys.

After that, pushes touching `trigger/**` redeploy the code automatically via
[`deploy-trigger.yml`](../.github/workflows/deploy-trigger.yml); the secret, vars, and
cron schedule stay put.

## Notes

- `repository_dispatch` only ever runs the workflow on the default branch (`main`),
  which is exactly what the crawl targets.
- An App private key doesn't expire — unlike a fine-grained PAT, there's nothing to
  rotate on a schedule (rotate only if it leaks).
- The Worker has no `fetch` handler and `workers_dev`/`preview_urls` are off, so it
  isn't reachable over HTTP — the key can only be exercised by the cron.
