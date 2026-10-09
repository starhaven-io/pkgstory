# Workflow triggers

Two separately deployed Cloudflare Workers schedule pkgstory workflows through
GitHub's `workflow_dispatch` endpoint as the **starhaven-bot** GitHub App:

| Worker | Configuration | Schedule (UTC) | Workflow |
| --- | --- | --- | --- |
| `pkgstory-crawl-trigger` | [wrangler.jsonc](wrangler.jsonc) | Every 30 minutes | [Crawl](../.github/workflows/crawl.yml) |
| `pkgstory-monitor-trigger` | [wrangler.monitor.jsonc](wrangler.monitor.jsonc) | Hourly at :11 | [Check crawl dispatch](../.github/workflows/check-crawl-dispatch.yml) |

## Why

GitHub's scheduled workflows can run hours apart despite an hourly cron. The
monitor Worker dispatches the existing check independently of the crawl Worker;
it does not wait for a crawl dispatch or crawl completion. Both workflows retain
their GitHub `schedule:` fallbacks.

The Workers share source code and depend on Cloudflare cron, GitHub, and the
starhaven-bot App. Their secret bindings and deployment workflows are separate.
This isolates a missing crawl cron or broken crawl Worker configuration, but
both Workers stop dispatching during a shared Cloudflare cron outage or loss of
App access. The GitHub fallback uses `GITHUB_TOKEN`, so it can still alert on
missing crawl dispatches during those failures, though scheduling delays can
postpone the alert by hours. Monitor `/health.json` from outside those dependencies
for timely detection of stale crawls and coverage during GitHub outages, as
described in the [operations runbook](../docs/OPERATIONS.md).

There is no separate alert when the monitor Worker stops dispatching. Checks
quietly fall back to GitHub's schedule until the Worker is restored.

## How they authenticate

Each tick signs a short-lived JWT with the App's private key, looks up the App's
installation on `pkgstory`, and mints a single-repo installation token scoped to
`actions: write` (~1h TTL). The dispatch endpoint needs no repository-content
write access. The `WORKFLOW` variable selects one of the two allowed workflows;
both always target `main`. Missing or unsupported targets fail before contacting
GitHub.

The App ID (`3331849`) is non-secret and lives in both configurations. Each Worker
requires its own `APP_PRIVATE_KEY` secret binding; deploying the monitor does not
copy the crawl Worker's secret.

## One-time setup

1. Make sure **starhaven-bot** is installed on `pkgstory`, grant it **Actions:
   Read and write**, and accept the permissions on the org installation. Keep
   permissions needed by other App consumers, including fleet sync in
   `dot_github`.
2. Generate a [dedicated App private key](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
   for the monitor Worker. With separate keys, rotating or revoking one Worker's
   key does not interrupt the other. Both still share the App's permissions and
   installation. Keep the crawl Worker's and other consumers' keys unchanged.
   GitHub supplies PKCS#1 PEM; WebCrypto requires PKCS#8. Convert it locally:
   ```sh
   openssl pkcs8 -topk8 -nocrypt \
     -in /path/to/starhaven-monitor.private-key.pem -out /path/to/starhaven-monitor.pk8.pem
   ```
3. Set the secret on the monitor Worker before its first deployment:
   ```sh
   cd trigger
   npm ci --strict-allow-scripts
   npx wrangler secret put APP_PRIVATE_KEY --config wrangler.monitor.jsonc < /path/to/starhaven-monitor.pk8.pem
   ```
   If the Worker does not exist, Wrangler creates a placeholder to hold the secret
   without prompting when stdin is redirected as above. Leave deployment to the
   Deploy Monitor Trigger workflow after the reviewed changes merge to `main`;
   that installs the code and cron. An existing crawl Worker needs no secret
   change when adding the monitor. To provision a new crawl Worker, set its
   PKCS#8 key the same way with `--config wrangler.jsonc` and let Deploy Trigger
   install it.

Configure the monitor's secret before merging changes that activate its
automatic deployment. Without it, scheduled invocations fail. Secrets persist
across redeploys. The project denies its current dependency install scripts;
run `just npm-policy` after dependency changes.

Changes to each configuration redeploy only its Worker. Shared source and
dependency changes redeploy both through [Deploy Trigger](../.github/workflows/deploy-trigger.yml)
and [Deploy Monitor Trigger](../.github/workflows/deploy-monitor-trigger.yml), with
separate concurrency groups. Both require `main` and use the `cloudflare`
environment. `just trigger-deploy-dry` validates both configurations.

## Verify scheduling

After merging the initial rollout, confirm both Deploy Trigger and Deploy Monitor
Trigger succeed. Allow up to 15 minutes for a new Cloudflare cron to propagate,
then check a scheduled :11 invocation with:

```sh
cd trigger
npx wrangler tail --config wrangler.monitor.jsonc
```

Confirm a new bot-authored `workflow_dispatch` run of `check-crawl-dispatch.yml`
on `main`, and check that its health result matches the crawl history. A manual
workflow dispatch verifies the check but does not establish cron delivery;
observe successive hourly invocations before calling scheduling verified.

## Notes

- Before rotating an App key, inventory both Workers and all other consumers,
  including fleet sync in `dot_github`. Update and verify every consumer before
  revoking the old key. Repository files do not establish which hosted secrets
  contain the same key.
- Neither Worker has a `fetch` handler, and `workers_dev`/`preview_urls` are off,
  so neither exposes a public HTTP endpoint.
