# Build

# Type-check the crawler (Node runs the TS directly; this is the compile gate)
build:
    npm run typecheck

# Install dependencies
install:
    npm install

# Test

# Run tests
test:
    npm test

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

# Audit GitHub Actions workflows
audit:
    zizmor --persona auditor .github/workflows/

# Site

# Build the site
site-build:
    cd site && npm run build

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
    cd site && npm install

# Preview the built site
site-preview:
    cd site && npm run preview

# Check for broken links in the built site and README
lychee: site-build
    lychee --config lychee.toml --root-dir "$(pwd)/site/dist/client" 'site/dist/client/**/*.html' README.md

# Trigger (crawl cron Worker)

# Install trigger Worker dependencies
trigger-install:
    cd trigger && npm install

# Run the trigger Worker locally (curl localhost:8787/__scheduled to fire the cron)
trigger-dev:
    cd trigger && npm run dev

# Type-check the trigger Worker
trigger-typecheck:
    cd trigger && npm run typecheck

# Deploy the trigger Worker to Cloudflare
trigger-deploy:
    cd trigger && npm run deploy

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
    echo "--- trigger-typecheck ---"
    (cd trigger && npm run typecheck) || failed=1
    if [ ${#skipped[@]} -gt 0 ]; then
        echo ""
        echo "Checks skipped due to missing tools:"
        for tool in "${skipped[@]}"; do
            echo "  - $tool"
        done
        failed=1
    fi
    exit $failed

# Install git hooks (DCO sign-off + pre-push checks) — run once per clone
install-hooks:
    git config core.hooksPath .githooks
