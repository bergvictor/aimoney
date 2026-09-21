#!/usr/bin/env sh
# AIMoney Lab shared D1 migration step (audit 2026-09-20-round2 Task 1).
# Single home for the sorted d1/migrate-*.sql loop + tolerate-list, called by
# both deploy/deploy.sh (manual) and .github/workflows/deploy-worker.yml
# ("Apply D1 migrations in sorted order") so CI and manual deploys converge.
# Second run is a clean duplicate-column no-op; a genuinely broken migration
# surfaces the driver error and exits 1.
set -eu
cd "$(dirname "$0")/.."

WRANGLER="${WRANGLER:-wrangler}"

for f in d1/migrate-*.sql; do
  [ -e "$f" ] || continue
  echo "==> D1: migration $f"
  if out=$($WRANGLER d1 execute aimoney --file="$f" --remote 2>&1); then
    echo "$out"
  else
    case "$(printf '%s' "$out" | tr '[:upper:]' '[:lower:]')" in
      *"duplicate column"*|*"already exists"*)
        echo "==> D1: $f already applied (continuing)" ;;
      *)
        echo "$out"
        echo "::error::D1 migration $f failed (not a duplicate-column no-op)"
        exit 1 ;;
    esac
  fi
done
