#!/usr/bin/env sh
# AIMoney Lab shared worker-rev stamp (audit 2026-09-20-round7 Task 3).
# Single home for stamping the deployed SHA into worker/src/rev.js, called by
# both deploy/deploy.sh (manual) and .github/workflows/deploy-worker.yml
# ("Stamp worker revision") so CI and manual deploys converge — the same
# pattern as deploy/apply-d1-migrations.sh. The worker serves the value from
# GET / as `rev`; wrangler dev keeps the committed "unknown".
# Usage: ./deploy/stamp-worker-rev.sh [sha] (default: current HEAD)
set -eu
cd "$(dirname "$0")/.."

SHA="${1:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
REV="$(printf '%s' "$SHA" | cut -c1-7)"
printf '// Deploy-stamped worker revision. deploy/stamp-worker-rev.sh rewrites this\n// file on every deploy; the committed "unknown" is the wrangler-dev default.\nexport const WORKER_REV = "%s";\n' "$SHA" > worker/src/rev.js
echo "stamped worker/src/rev.js rev=${REV}"
