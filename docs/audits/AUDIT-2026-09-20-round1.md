# AUDIT-2026-09-20-round1 — aimoney (angle: WASTE, read-only)

Lane metric (aimoney): experiments decided (won/lost + post-mortem) per week, vetted proposals that become experiments, unreviewed backlog drained. Live values from the repo's own health endpoint today (`_night/live/aimoney_pages_dev_api_health.html`, rev d1aa266): `decisions_last_7d: 0`, `vetted_last_7d: 0`, `unreviewed: 11`, `oldest_unreviewed_age_h: 165.1` (~6.9d), `bare_without_brief: 19/27`, `experiments_by_status: {planned: 2}` (zero running/won/lost), `revenue_total: 0`. Every finding below is ranked by how it serves a sub-minute phone clear or stops feeding the backlog.

## 1. What this project is and how it runs

- Purpose: AIMoney Lab — a ranked ledger of AI-money opportunities with research briefs, experiments, and a cron research agent that proposes new rows; the human vets, tests, kills/scales.
- Entry points: dashboard `public/index.html` + `public/app.js`; API `functions/api/[[path]].js` (D1); agent `worker/src/index.js` (`scheduled` + `fetch` for `/`, `/run`, `/ping-ai`, `/debug-classify`).
- Live surfaces: `https://aimoney.pages.dev`, `/api/health`, worker `https://aimoney-research.<account>.workers.dev/` (`deploy/public-surfaces.json`).
- Scheduled jobs: one cron `0 */6 * * *` (`worker/wrangler.toml:9`); `.github/workflows/deploy-worker.yml` redeploys the worker (+schema) on push to `worker/**` or `d1/**`.
- Deploys: Pages is git-connected (`public/`, build `scripts/stamp-release.sh` stamps `release.json`); `./deploy/deploy.sh` runs D1 schema+migrations, stamps, Pages deploy, worker deploy; `./deploy/verify.sh` checks markers, non-empty list, agent freshness ≤12h.

## 2. End-to-end walk-through

Signal → proposal → brief → vet → experiment → decision. Hops (file:line):

1. Cron fires `scheduled()` → `runResearch(env, "cron")` (`worker/src/index.js:484`, `:182`); manual path `POST /run` returns 202 and runs the same pass in `waitUntil` (`worker/src/index.js:540-548`).
2. Collect: `hnSignals()` ×4 queries, `redditSignals()` ×3, `githubSignals()` ×2 (`worker/src/index.js:48`, `:72`, `:96`, `:217`) → one batched `INSERT OR IGNORE` (`worker/src/index.js:222-227`).
3. Stale sweep (>30d → noise, `worker/src/index.js:236-240`) → take oldest 6 unprocessed (`worker/src/index.js:242-244`) → exact-URL supports pre-pass, no AI (`worker/src/index.js:250-267`, pure `exactUrlTarget` `:153`).
4. Classify: one Mistral NDJSON call over ≤6 signals vs top-60 list (`worker/src/index.js:277-294`, `aiComplete` `:121-138`) → verdict loop inserts ≤2 `researching` rows capped ≤6000 with `UNREVIEWED` (`worker/src/index.js:300-355`, cap `worker/src/lib.js:21-32`, estimates `worker/src/index.js:165-180`).
5. Brief: 1 bare row (top-scored, or oldest-unreviewed past 48h) + optionally 1 extra oldest bare row past 48h (`worker/src/index.js:370-473`); manual runs skip via `briefDeadline = -1` (`worker/src/index.js:215`).
6. Human vets in dashboard: `refresh()` boot (`public/app.js:1118`) → review chip + oldest-first list (`public/app.js:224-248`) → Vet / Vet-&-log-starter / Kill (`public/app.js:377`, `:403`, `:435`) → `PATCH /api/opportunities/:id` clears marker, lifts cap, tags `[date vetted]` (`functions/api/[[path]].js:123-160`).
7. Experiment: log/start/lose/win from board or drawer (`public/app.js:1032-1055`, `:584-643`) → `POST/PATCH /api/experiments` with closure gate (won/lost require `result` + `post_mortem`, stamps `started_at`/`ended_at`, cents + `revenue_source`, outcome ledger line into parent notes) (`functions/api/[[path]].js:236-340`); header counts decisions/vetted/revenue from `/api/health` (`functions/api/[[path]].js:355-391`).
8. Scores recompute on every write via shared `effectiveScore` (`functions/api/[[path]].js:10,66,108,148`; API imports it from `worker/src/lib.js`).

Where it most often breaks or goes silent: the human bottleneck — 11 unreviewed, oldest 6.9d, `vetted_last_7d = 0`, 19/27 rows brief-less, 2 planned experiments with zero running. Silent machine drops compound it: malformed brief JSON is swallowed (`worker/src/index.js:423` `catch {}`), invalid verdicts are dropped or marked noise without surfacing (`worker/src/index.js:300-308`), the brief pass self-skips past deadline (`worker/src/index.js:374`), and the whole pass must fit `waitUntil`'s ~30s cap on the manual path (`worker/src/index.js:7-11`).

## 3. Health signals measured here

- Test suite (`npm test` = `node --test worker/src/lib.test.js worker/src/index.test.js functions/api/api.test.mjs public/tab-icon.test.mjs public/dashboard.test.mjs`): exit 0 — `# tests 190, # suites 67, # pass 190, # fail 0, # cancelled 0, # skipped 0, # duration_ms 1379.76`. Baseline log (`_night/tests-baseline.log`): 190/190, `duration_ms 283.6074` on Windows. Same green, slower here (sandbox overhead). Warnings only: `MODULE_TYPELESS_PACKAGE_JSON` (add `"type": "module"`) and an experimental-proxy notice.
- `python3 -m compileall`: N/A — zero `*.py` files in the repo (glob search, no matches). Python appears only as JSON one-liners inside `deploy/deploy.sh:41` and `deploy/verify.sh:39,43,51`. JS syntax is covered by the passing suite, which imports every source file.
- Live surfaces: `_night/live/aimoney_pages_dev.html` byte-matches `public/index.html` (light palette, `color-scheme: light`, no dark branch in `public/styles.css`; `<link rel="icon" href="/favicon.svg">` + `<meta name="theme-color" content="#0d6b3f">`; inline `$` brand mark matching `public/favicon.svg`, 1 line / ~300 bytes). Guard suite `public/tab-icon.test.mjs` passes 5/5. All 5 standing surface rules hold — no surface-rule findings this round. No placeholder text; `Loading …` rows are JS-boot states only.
- Dead code: `scoreOf` imported but never used in `worker/src/index.js:140` (only `effectiveScore` is used, `:335`); unreachable toast gates after `return openAdminModal(...)` in `public/app.js:380` and `:438` (each preceded by an identical `if (!state.token) return ...` at `:378`/`:436`); `GET /api/briefs` (`functions/api/[[path]].js:162-169`) has no first-party caller — the dashboard renders briefs from the detail payload (`public/app.js:711,730`) and list excerpts.
- Duplicated logic: `clamp10` in `functions/api/[[path]].js:12-16` vs `worker/src/lib.js:4-7` (API already imports `effectiveScore` from lib but not `clamp10`); classify prompt built twice (`worker/src/index.js:277-287` vs `/debug-classify` `:519-528`); brief prompt+parse+insert twice (`worker/src/index.js:394-424` vs extra-brief `:439-470`); `inlineWinClose` (~65 lines, `public/app.js:304-371`) mirrors `inlinePostMortem` (`:265-303`); oldest-UNREVIEWED `SELECT` twice per cron tick (`worker/src/index.js:377` and `:430-432`); three separate `#board` click listeners (`public/app.js:1032,1041,1050`); `centsDollars` (API `:20`) vs `moneyCents` (`public/app.js:51`) — documented-deliberate mirror.
- TODO density: **0** in source — regex `TODO|FIXME|HACK\(|XXX` matches only the three prior audit docs in `docs/audits/` quoting the pattern.
- Repo docs: `README.md` only; no `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING` at root or in subdirs. `.env`/secrets never opened.

## 4. Ranked findings (max 8)

### F1. Every refresh re-fetches the review list it already holds

Evidence — `public/app.js:1120-1131`: `refresh()` fetches `/api/opportunities?limit=200` AND (via `refreshReview`, `public/app.js:226`) `/api/opportunities?unreviewed=1&sort=oldest&limit=200`. The second call is a subset of the first: `unreviewed=1` only adds `o.notes LIKE '%UNREVIEWED%'` (`functions/api/[[path]].js:52`) and `oldest` only changes `ORDER BY` to `o.created_at ASC` (`:53-54`) — and every field needed (`notes`, `created_at`) is already in the main payload. Each list call also runs 4 correlated subqueries per row (`brief_count`, `brief_first_steps`, `brief_summary`, `experiment_count`, `functions/api/[[path]].js:57-61`).

Why it costs: `refresh()` runs after every vet, kill, start, lose, win, save, and add — so every single phone decision pays a full redundant API round-trip plus ~11×4 server subqueries, slowing the sub-minute clear and doubling D1 read load for zero new information.

Fix: derive `state.reviewList` client-side in `refreshReview` by filtering `state.opportunities` on `UNREVIEWED` and sorting oldest-first; keep the API call only as a fallback when the main list is truncated (`length === limit`). Touch `public/app.js` and `public/dashboard.test.mjs` (assert chip count/age identical with the fetch stubbed to fail). Size S. Risk low — same row shape, truncation-guarded.

### F2. Start-here strip spends a detail fetch on data the list already carries

Evidence — `public/app.js:121-129`: when the top pick has no cached brief text, the strip fires `api(\`/api/opportunities/${top.id}\`)` just to compute `firstStepsFirstLine(d.briefs[0])`. But the list payload already includes `(SELECT b.first_steps ... ORDER BY b.version DESC LIMIT 1) AS brief_first_steps` (`functions/api/[[path]].js:59`) — the same latest-brief row the detail call reads. Server-side the detail call costs 3 sequential selects (row + briefs + experiments, `functions/api/[[path]].js:73-83`).

Why it costs: every top-pick change (i.e. after every vet/kill that re-ranks #1) burns a needless round-trip before the owner sees his next action — the exact "decision needs everything in front of it" path.

Fix: use `firstStepsFirstLine({ first_steps: top.brief_first_steps })` directly in `renderStartHere` and delete the `topBriefText` fetch/cache (`public/app.js:100-103,121-129` plus the `topBriefText: {}` init at `:8`). Touch `public/app.js` and `public/dashboard.test.mjs`. Size S. Risk low — identical excerpt source, null-safe like the review decision line.

### F3. `/api/meta` is refetched on every refresh although it never changes per deploy

Evidence — `public/app.js:1130`: `state.meta = await api("/api/meta")` sits inside `refresh()`, after the parallel four. The handler returns only deploy-static values: `worker_url`, `writes_enabled`, `scoring` (`functions/api/[[path]].js:393-399`).

Why it costs: one more serial round-trip (it awaits after the parallel batch) on every boot and every post-action refresh — pure repeat work with no new information, adding latency to each decision cycle.

Fix: fetch `/api/meta` once at boot (module init or first `refresh()` only) and reuse `state.meta` thereafter; re-fetch only on explicit retry-after-failure. Touch `public/app.js` and `public/dashboard.test.mjs`. Size S. Risk low — values are env-derived and static until redeploy.

### F4. `/api/health` runs 12 sequential D1 queries plus a release.json subrequest per call

Evidence — `functions/api/[[path]].js:356-372`: the health branch awaits ~12 separate selects in sequence (count, unreviewed, bare, exp-by-status, lastOk, oldestUnreviewed, decisions, revenue_7d, revenue_total, spent_total, vetted, vettedNoExp, noise), then `fetch(new URL("/release.json", url.origin))` at `:386-390` on every call. Health is fetched by every dashboard `refresh()` (every action) and twice by `deploy/verify.sh` (`:32` check + `:51` freshness).

Why it costs: health is the hottest endpoint and each hit pays a dozen D1 round-trips where independent pairs scan the same rows — `decisionsRow`+`revenueRow` both scan won/lost-closed-in-7d (`:365-366`), `revenueTotalRow`+`spentTotalRow` both scan all won/lost (`:367-368`) — plus a same-origin subrequest for a static file.

Fix: merge the paired scans (`COUNT(*)`+`SUM()` in one statement each; `COUNT(*)`+`MIN(created_at)` for the unreviewed count/oldest pair) and issue the remaining independent selects via one `env.DB.batch(...)` as the worker already does for inserts (`worker/src/index.js:223`). Keep every response key byte-identical. Touch `functions/api/[[path]].js` and `functions/api/api.test.mjs`. Size M. Risk low-medium — SQL-only change, existing health-key tests pin the contract.

### F5. Each run fetches and stores ~72 signals but triages 6; the rest queue, then sweep to noise

Evidence — `MAX_SIGNALS_PER_SOURCE = 8` (`worker/src/index.js:14`) × 4 HN + 3 Reddit + 2 GitHub queries (`:25-28`, `:116` slices to 2) = up to 72 collected and batch-inserted per run (`:217-227`), while triage takes `MAX_AI_SIGNALS = 6` (`:15`, `:242-244`) and inserts at most 2 (`:16`, `:317`). At 4 runs/day that's ~288 stored vs 24 triaged; the overflow ages out via the 30d sweep (`:236-240`) having consumed fetch time, insert batch, and D1 rows for nothing — and whatever does get inserted (≤8/day) feeds the 11-deep unreviewed backlog nobody is clearing.

Why it costs: external fetch volume, D1 growth, and — worst for the lane metric — proposal inflow into a queue whose drain rate is zero (`vetted_last_7d: 0`). Collection is tuned for a reviewer that doesn't exist.

Fix: gate collection on queue depth — `SELECT COUNT(*) FROM signals WHERE processed = 0` first and skip the source fetches when unprocessed depth exceeds ~2 runs' worth (12), letting the take in `:242` drain the queue; alternatively cut `MAX_SIGNALS_PER_SOURCE` to 2–3 to match consumption. Touch `worker/src/index.js` and `worker/src/index.test.js` (static guards already cover the take/sweep). Size M. Risk low — collection is idempotent (`INSERT OR IGNORE`) and triage order is unchanged.

### F6. Exact-URL pre-pass loads two full tables to match ≤6 signals

Evidence — `worker/src/index.js:251-256`: every run with fresh signals runs `SELECT id, source_url FROM opportunities WHERE source_url != ''` and `SELECT url, opportunity_id FROM signals WHERE opportunity_id IS NOT NULL AND url != ''`, then loops `exactUrlTarget` (`:153-163`) per signal. Cost grows with both tables on every tick, yet at most 6 URLs are ever matched — and neither `opportunities.source_url` nor `signals.url` has an index (`d1/schema.sql:28-29,85` cover status/score, category, processed/created_at only).

Why it costs: two unbounded full-table scans per run (4×/day forever) for a lookup that should be O(1) per signal; as signals accumulate toward the 30d sweep horizon this is the fastest-growing per-run cost.

Fix: replace the bulk loads with per-signal indexed lookups (`SELECT id FROM opportunities WHERE source_url = ? LIMIT 1`, same for signals) and add `CREATE INDEX IF NOT EXISTS` on both columns via `d1/schema.sql` plus a `d1/migrate-*.sql` (deploy applies idempotently, `deploy/deploy.sh:34-38`). Touch `worker/src/index.js`, `d1/schema.sql`, new migration, `worker/src/index.test.js`. Size M. Risk low-medium — same match semantics (`exactUrlTarget` unit tests pin them); migration is additive and idempotent.

### F7. Every run finishes the run log twice; the first write is immediately overwritten

Evidence — `worker/src/index.js:474-475`: `await finish("ok");` then `await finish("ok", (briefMode === "skipped" ? "" : "brief:" + briefMode) + ...)`. Both issue the same `UPDATE agent_runs SET ... WHERE id=?` (`:202-208`); the second overwrites every column the first just wrote.

Why it costs: one wasted D1 write and its latency on 100% of successful runs — republished output that did not change, on the path already fighting the `waitUntil` wall clock (`worker/src/index.js:7-11`).

Fix: delete the first call and keep only the message-carrying `finish("ok", ...)` at `:475`. Touch `worker/src/index.js` only (no test change needed; run-log assertions still see one final row). Size S. Risk low — the surviving write carries strictly more information.

### F8. Manual triage triggers an immediate refresh that cannot show anything new

Evidence — `public/app.js:1066-1073`: after `POST {worker}/run` returns, the handler calls `setTimeout(refresh, 45000)` AND `await refresh()` immediately. But `/run` returns 202 while the pass runs asynchronously in `waitUntil` (`worker/src/index.js:540-548`, `runResearch` takes tens of seconds) — the immediate refresh re-reads pre-run state (6 API calls, F1–F4) and always renders unchanged data.

Why it costs: six API calls' worth of load and a misleading "nothing happened" paint on every manual trigger — republished output that did not change, on a button whose whole point is impatience.

Fix: drop the immediate `await refresh()` and keep only the delayed refresh; better, poll `/api/runs?limit=1` until a new run id appears (bounded ~90s) then refresh once. Touch `public/app.js` and `public/dashboard.test.mjs`. Size S. Risk low — read-only timing change; the 45s refresh already proves delayed consistency.

## 5. What NOT to change

- Agent never moves status: "The agent never moves status." (`README.md:72`; `worker/src/index.js:4-5` "The agent PROPOSES; the human owns the testing workflow"). Any auto-vet/auto-test/auto-kill needs an explicit owner decision and reversibility rule — out of scope for waste cuts.
- UNREVIEWED score cap: "its EFFECTIVE score is clamped below the human seeds" (`worker/src/lib.js:18-20`, `UNREVIEWED_SCORE_CAP = 6000`, `:22`). Do not lift or retune while the backlog is unreviewed.
- New-proposal inflow cap: "Each run inserts at most 2 new proposals (inflow ≤ brief capacity)" (`README.md:76`; `MAX_NEW_PER_RUN = 2`, `worker/src/index.js:16`). F5 trims collection ahead of it; the cap itself stays.
- Closure gate: won/lost require `result` + `post_mortem` (`functions/api/[[path]].js:247-252,310-314`); never invent revenue (`revenue_cents`/`spent_cents` default 0, `:258-260`) and never auto-apply the suggested rescore ("never auto-applied", `README.md:74`).
- Manual runs skip briefs by design: "Manual `Run triage now (briefs on cron)` collects and triages only" (`README.md:77`; `briefDeadline = -1`, `worker/src/index.js:215`; 202 carries `briefs_skipped:true`, `:548`). Do not "fix" by briefing on manual.
- Token-gated writes: admin `Bearer` checks (`functions/api/[[path]].js:24-32`, worker `/run` `:541-543`, dashboard modal gates e.g. `public/app.js:378`); token rotation and `ADMIN_TOKEN` values need the owner — never touch credentials, `.env`, or deploy/CI config for these cuts.
- Human-owned decisions: vet/kill/testing/scaling moves, post-mortem text, revenue amounts and sources — all require the owner; the 30d signal sweep (`worker/src/index.js:232-240`) and `GET /api/briefs` public shape stay as-is.

## 6. Proposed next tasks (2–4)

1. `Derive review list client-side; drop second list fetch` — files: `public/app.js`, `public/dashboard.test.mjs`. Acceptance: one `refresh()` issues 5 API calls, review count/age/chip identical with the unreviewed fetch stubbed to fail, truncation fallback covered, `npm test` green.
2. `Fetch /api/meta once; drop immediate post-triage refresh` — files: `public/app.js`, `public/dashboard.test.mjs`. Acceptance: meta fetched once per boot; manual run paints once via the delayed refresh only; `npm test` green.
3. `Single run-finish write; reuse oldest-unreviewed row` — files: `worker/src/index.js`, `worker/src/index.test.js`. Acceptance: one `agent_runs` finish UPDATE per run; brief-mode and extra-brief share a single oldest query; `npm test` green.
4. `Merge health D1 queries; keep every key` — files: `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Acceptance: identical health JSON incl. all keys `verify.sh` needs; paired scans merged and independents batched; `npm test` green.
