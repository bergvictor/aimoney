#!/usr/bin/env sh
# AIMoney Lab versioned deploy: D1 migrations + Pages site + research worker.
#   export CLOUDFLARE_ACCOUNT_ID=97120bae9770152d66a6881976a2a2d4
#   export CLOUDFLARE_API_TOKEN=<token: Pages + Workers + D1 + AI edit>
#   ./deploy/deploy.sh
# Secrets never enter version control; the token lives only in this shell.
set -eu
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN

if command -v wrangler >/dev/null 2>&1; then
  WRANGLER="wrangler"
elif [ -x "./node_modules/.bin/wrangler" ]; then
  WRANGLER="./node_modules/.bin/wrangler"
else
  echo "deploy.sh: wrangler not found (npm i -g wrangler, or npm install here)"; exit 1
fi
command -v git >/dev/null 2>&1 || { echo "deploy.sh: git not found"; exit 1; }

REV="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  REV="${REV}-dirty"
fi
echo "==> aimoney deploy rev=${REV}"

# 1. D1 schema (idempotent) + seed (only when the table is empty, so agent and
# human rows are never overwritten by a redeploy).
echo "==> D1: schema"
$WRANGLER d1 execute aimoney --file=d1/schema.sql --remote
# D1 migrations run via deploy/apply-d1-migrations.sh (shared with
# .github/workflows/deploy-worker.yml "Apply D1 migrations in sorted order"):
# same sorted glob, same tolerate-list — one home so CI and manual deploys converge.
WRANGLER="$WRANGLER" ./deploy/apply-d1-migrations.sh
# Seed guard (fail closed): COUNT must be a readable row count. A failed
# measurement aborts the deploy before the seed step — never seed on a
# failed read (a blind re-seed duplicates briefs/experiments on live D1).
COUNT="$($WRANGLER d1 execute aimoney --remote --json \
  --command "SELECT COUNT(*) AS n FROM opportunities" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['results'][0]['n'])" || true)"
case "${COUNT:-}" in
  ''|*[!0-9]*)
    echo "deploy.sh: D1 seed guard cannot measure the opportunities table (got '${COUNT:-empty}'); refusing to seed" >&2
    exit 1
    ;;
esac
if [ "$COUNT" = "0" ]; then
  echo "==> D1: empty table, applying seed"
  $WRANGLER d1 execute aimoney --file=d1/seed.sql --remote
else
  echo "==> D1: ${COUNT} opportunities present, seed skipped"
fi

# 2. Stamp the revision marker the verifier checks (cache-busted).
printf '{"project":"aimoney","revision":"%s","built_at":"%s"}\n' "$REV" "$STAMP" > public/release.json
echo "==> stamped public/release.json rev=${REV}"

# 3. Pages site (direct deploy; the Git-connected project redeploys itself on push).
echo "==> Pages: deploy"
$WRANGLER pages deploy public --project-name aimoney --commit-dirty=true

# 4. Research worker (cron + AI + D1).
echo "==> Worker: deploy"
$WRANGLER deploy --config worker/wrangler.toml

echo "==> deployed rev=${REV}; now run ./deploy/verify.sh"
