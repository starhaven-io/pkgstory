# Build

# Type-check the crawler (Node runs the TS directly; this is the compile gate)
build:
    npm run typecheck

# Install dependencies
install:
    npm ci --strict-allow-scripts

# fleet:block npm-policy
# Verify every dependency install script is denied or exactly approved
npm-policy:
    node scripts/check-npm-install-policy.mjs . site trigger
# fleet:end

# Test

# Run tests
test:
    npm test

# Run tests and write the Codecov LCOV report
test-cov:
    npm run test:coverage

# Crawl

# Crawl package histories into the SQLite index (default: a curated demo set)
crawl *args:
    node src/cli.ts crawl {{ args }}

# Lint

# Type-check
typecheck:
    npm run typecheck

# Lint + format check with Biome
lint:
    npm run lint

# Format code with Biome
format:
    npm run format

# Check for typos
typos:
    typos

# fleet:block audit
audit:
    zizmor --persona auditor .github/workflows/
# fleet:end

# Site

# Build the site
site-build:
    cd site && npm run build

# Seed the local Wrangler D1/KV site state from a SQLite crawl database
site-seed-local db="pkgstory.db": site-install
    #!/usr/bin/env bash
    set -euo pipefail
    sql="$(mktemp "${TMPDIR:-/tmp}/pkgstory-d1.XXXXXX.sql")"
    trap 'rm -f "$sql"' EXIT
    node src/cli.ts export --db "{{db}}" > "$sql"
    (cd site && WRANGLER_SEND_METRICS=false ./node_modules/.bin/wrangler d1 execute pkgstory --local --file "$sql" >/dev/null)
    node src/cli.ts cache --d1 local

# Reseed the deployed D1/KV site state from a full-crawl database
site-seed-remote db="pkgstory.db": site-install
    #!/usr/bin/env bash
    set -euo pipefail
    # The slice drops and rebuilds every table, so the deployed site serves errors from
    # the first DROP until the last INSERT lands. Seed only from a `crawl --all` database:
    # an incremental-only one exports no contributors at all.
    read -rp "Reseed the DEPLOYED pkgstory D1 from {{db}}? The live site errors until it finishes. [y/N] " reply
    [[ "${reply}" == [yY] ]] || { echo "aborted"; exit 1; }
    sql="$(mktemp "${TMPDIR:-/tmp}/pkgstory-d1.XXXXXX.sql")"
    trap 'rm -f "$sql"' EXIT
    node src/cli.ts export --db "{{db}}" > "$sql"
    (cd site && WRANGLER_SEND_METRICS=false ./node_modules/.bin/wrangler d1 execute pkgstory --remote --yes --file "$sql" >/dev/null)
    node src/cli.ts cache --d1 remote

# Start the site dev server
site-dev:
    cd site && npm run dev

# Format site files with Prettier
site-format:
    cd site && npm run format

# Check site formatting
site-format-check:
    cd site && npm run format:check

# Install site dependencies
site-install:
    cd site && npm ci --strict-allow-scripts

# Preview the built site
site-preview:
    cd site && npm run preview

# Build the SSR site, then check documentation links
lychee: site-build
    lychee --config lychee.toml README.md trigger/README.md

# Trigger (crawl cron Worker)

# Install trigger Worker dependencies
trigger-install:
    cd trigger && npm ci --strict-allow-scripts

# Run the trigger Worker locally (curl localhost:8787/__scheduled to fire the cron)
trigger-dev:
    cd trigger && npm run dev

# Type-check the trigger Worker
trigger-typecheck:
    cd trigger && npm run typecheck

# Verify the trigger Worker deployment without publishing
trigger-deploy-dry:
    cd trigger && WRANGLER_SEND_METRICS=false npm run deploy:dry

# Deploy the trigger Worker to Cloudflare
trigger-deploy:
    cd trigger && WRANGLER_SEND_METRICS=false npm run deploy

# Check

# Run all checks (mirrors CI; skips tools that aren't installed)
check:
    #!/usr/bin/env bash
    set -euo pipefail
    failed=0
    skipped=()
    run() {
        echo "--- $1 ---"
        shift
        if ! "$@"; then
            failed=1
        fi
    }
    skip() {
        echo "--- $1 --- skipped ($2 not found)"
        skipped+=("$2 (brew install $3)")
    }
    run npm-policy node scripts/check-npm-install-policy.mjs . site trigger
    run typecheck npm run --silent typecheck
    run lint npm run --silent lint
    if command -v typos &>/dev/null; then
        run typos typos
    else
        skip typos typos typos-cli
    fi
    if command -v zizmor &>/dev/null; then
        run audit zizmor --persona auditor .github/workflows/
    else
        skip audit zizmor zizmor
    fi
    run test npm test
    echo "--- site-format-check ---"
    (cd site && npm run format:check) || failed=1
    echo "--- site-build ---"
    (cd site && npm run build) || failed=1
    echo "--- site-deploy-dry ---"
    (cd site && WRANGLER_SEND_METRICS=false npm run deploy:dry) || failed=1
    echo "--- trigger-typecheck ---"
    (cd trigger && npm run typecheck) || failed=1
    echo "--- trigger-deploy-dry ---"
    (cd trigger && WRANGLER_SEND_METRICS=false npm run deploy:dry) || failed=1
    if [ ${#skipped[@]} -gt 0 ]; then
        echo ""
        echo "Checks skipped due to missing tools:"
        for tool in "${skipped[@]}"; do
            echo "  - $tool"
        done
        failed=1
    fi
    exit $failed

# fleet:block install-hooks
# Install git hooks (DCO sign-off + pre-push checks). Run once per clone.
install-hooks:
    git config core.hooksPath .githooks
# fleet:end

# fleet:block pinprick-audit
pinprick-audit:
    pinprick audit .
# fleet:end
