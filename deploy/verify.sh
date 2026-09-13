#!/usr/bin/env sh
# AIMoney Lab verification: fetch every public surface with a cache-buster and
# confirm the expected revision/content. Any stale/mismatched/unreachable
# surface fails the rollout. No credentials needed (reads are public).
set -eu
cd "$(dirname "$0")/.."

PAGES="${AIMONEY_PAGES_URL:-https://aimoney.pages.dev}"
WORKER="${AIMONEY_WORKER_URL:-}"
if [ -z "$WORKER" ]; then
  WORKER="https://aimoney-research.levitinvlad.workers.dev"
fi
CB="cb=$(date +%s)"
FAIL=0

check() { # name, url, grep-pattern
  BODY="$(curl -fsSL --max-time 25 "$2" 2>/dev/null || true)"
  if [ -z "$BODY" ]; then
    echo "FAIL $1: unreachable ($2)"; FAIL=1; return
  fi
  if printf '%s' "$BODY" | grep -q "$3"; then
    echo "ok   $1"
  else
    echo "FAIL $1: marker not found /$3/"; FAIL=1
  fi
}

echo "==> verifying ${PAGES} (?${CB})"
check "dashboard-html"      "$PAGES/?$CB"                  "AIMoney Lab"
check "dashboard-appjs"     "$PAGES/app.js?$CB"            "renderLedger"
check "release-marker"      "$PAGES/release.json?$CB"      '"project":"aimoney"'
check "api-health"          "$PAGES/api/health?$CB"        '"ok":true'
check "api-priority-list"   "$PAGES/api/opportunities?$CB" '"opportunities"'
check "api-runs"            "$PAGES/api/runs?$CB"          '"runs"'

echo "==> verifying ${WORKER}"
check "worker-status"       "$WORKER/?$CB"                 '"agent":"research-v1"'

REV="$(curl -fsSL --max-time 25 "$PAGES/release.json?$CB" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('revision','?'))" 2>/dev/null || echo ?)"
echo "==> live revision: ${REV}"

# Non-empty priority list: the seed (or the agent) must have populated D1.
N="$(curl -fsSL --max-time 25 "$PAGES/api/opportunities?limit=1&$CB" 2>/dev/null | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('opportunities',[])))" 2>/dev/null || echo 0)"
if [ "${N:-0}" -ge 1 ]; then
  echo "ok   priority-list-nonempty"
else
  echo "FAIL priority-list-nonempty: D1 has no opportunities (seed not applied?)"; FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "==> VERIFY FAILED — rollout incomplete"; exit 1
fi
echo "==> VERIFY PASSED"
