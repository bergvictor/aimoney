#!/usr/bin/env sh
# AIMoney Lab verification: fetch every public surface with a cache-buster and
# confirm the expected revision/content. Any stale/mismatched/unreachable
# surface fails the rollout. No credentials needed (reads are public).
# Usage: ./deploy/verify.sh [expected-sha] (default: current short HEAD;
# EXPECTED_REV overrides the default when no arg is given).
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

# Live-revision gate: the edge must serve the deployed commit. release.json
# is stamped at build time (Pages build command `scripts/stamp-release.sh`;
# manual deploys stamp in deploy.sh step 2), so a wrong revision means a
# stale edge, a queued build, or a skipped stamp step.
EXPECTED_REV="${1:-${EXPECTED_REV:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}}"
VERIFY_ATTEMPTS="${VERIFY_ATTEMPTS:-6}"
VERIFY_RETRY_DELAY="${VERIFY_RETRY_DELAY:-10}"
if [ "$EXPECTED_REV" = "unknown" ]; then
  echo "FAIL live-revision: cannot determine the expected revision (pass it as \$1 or set EXPECTED_REV)"; FAIL=1
else
  ATTEMPT=0
  REV=""
  while [ "$ATTEMPT" -lt "$VERIFY_ATTEMPTS" ]; do
    ATTEMPT=$((ATTEMPT + 1))
    BODY="$(curl -fsSL --max-time 25 "$PAGES/release.json?$CB" 2>/dev/null || true)"
    if [ -z "$BODY" ]; then
      echo "FAIL live-revision: unreachable ($PAGES/release.json)"; FAIL=1; break
    fi
    case "$BODY" in
      <*|*"<html"*|*"<!DOCTYPE"*)
        echo "FAIL live-revision: expected JSON, got an HTML body (edge error page?)"; FAIL=1; break ;;
    esac
    REV="$(printf '%s' "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('revision',''))" 2>/dev/null || true)"
    if [ -z "$REV" ]; then
      echo "FAIL live-revision: unparsable body (not JSON with a revision key)"; FAIL=1; break
    fi
    if [ "$REV" = "dev-undeployed" ]; then
      echo "FAIL live-revision: placeholder revision dev-undeployed (stamp step skipped?)"; FAIL=1; break
    fi
    if [ "$REV" = "$EXPECTED_REV" ]; then
      echo "ok   live-revision (${REV})"; break
    fi
    if [ "$ATTEMPT" -ge "$VERIFY_ATTEMPTS" ]; then
      echo "FAIL live-revision: stale revision ${REV}, expected ${EXPECTED_REV} after ${VERIFY_ATTEMPTS} tries"; FAIL=1; break
    fi
    echo "...  live-revision stale (${REV}, expected ${EXPECTED_REV}), retry ${ATTEMPT}/${VERIFY_ATTEMPTS} in ${VERIFY_RETRY_DELAY}s"
    sleep "$VERIFY_RETRY_DELAY"
  done
fi

# Non-empty priority list: the seed (or the agent) must have populated D1.
N="$(curl -fsSL --max-time 25 "$PAGES/api/opportunities?limit=1&$CB" 2>/dev/null | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('opportunities',[])))" 2>/dev/null || echo 0)"
if [ "${N:-0}" -ge 1 ]; then
  echo "ok   priority-list-nonempty"
else
  echo "FAIL priority-list-nonempty: D1 has no opportunities (seed not applied?)"; FAIL=1
fi

# Fresh agent runs: fail when the last ok run is older than 2x cron (12h).
HOURS="$(curl -fsSL --max-time 25 "$PAGES/api/health?$CB" 2>/dev/null | python3 -c "import json,sys; v=json.load(sys.stdin).get('hours_since_last_ok_run'); print('' if v is None else v)" 2>/dev/null || echo '')"
if [ -z "$HOURS" ]; then
  echo "FAIL agent-freshness: hours_since_last_ok_run missing (no ok run yet?)"; FAIL=1
elif awk "BEGIN{exit !( $HOURS > 12 )}"; then
  echo "FAIL agent-freshness: last ok run ${HOURS}h ago (>12h)"; FAIL=1
else
  echo "ok   agent-freshness (${HOURS}h since last ok run)"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "==> VERIFY FAILED — rollout incomplete"; exit 1
fi
echo "==> VERIFY PASSED"
