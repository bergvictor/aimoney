#!/usr/bin/env sh
# Stamp public/release.json for Git-connected Pages builds.
# Cloudflare provides CF_PAGES_COMMIT_SHA; locally it falls back to git.
set -eu
SHA="${CF_PAGES_COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
REV="$(printf '%s' "$SHA" | cut -c1-7)"
REL="$(python3 -c "import json; print(json.load(open('package.json')).get('version','unknown'))" 2>/dev/null || echo unknown)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"project":"aimoney","revision":"%s","release":"%s","built_at":"%s"}\n' "$SHA" "$REL" "$STAMP" > public/release.json
echo "stamped public/release.json rev=${REV} release=${REL}"
