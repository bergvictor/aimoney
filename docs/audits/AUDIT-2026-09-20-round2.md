# AUDIT-2026-09-20-round2 — aimoney (angle: WASTE, read-only)

Clone HEAD: `68ab209` ("Night round 1 (aimoney): Derive review list client-side; fetch meta once; single run-finish write"). Live rev (`_night/live/aimoney_pages_dev_api_health.html`): `d1aa266` — one commit behind HEAD; the delta is perf-only, every drain tool from rounds 1–3 is live. No `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING` in repo (glob search empty); governed by `README.md` plus the session standing rules. `.env`/secrets/tokens never opened. No existing file edited; this file is the only one created.

## 1. What this project is and how it runs

- Purpose: AIMoney Lab — a ranked ledger of AI-money opportunities with research briefs and experiments; a cron agent proposes rows, the human vets, tests, kills/scales.
- Entry points: dashboard `public/index.html` + `public/app.js`; API `functions/api/[[path]].js` (D1); agent `worker/src/index.js` (`scheduled` + `fetch` for `/`, `/run`, `/ping-ai`, `/debug-classify`) + `worker/src/lib.js`.
- Live surfaces: `https://aimoney.pages.dev`, `/api/health`, worker `https://aimoney-research.<account>.workers.dev/` (`deploy/public-surfaces.json:31-44`).
- Scheduled jobs: one cron `0 */6 * * *` (`worker/wrangler.toml:8-9`); `.github/workflows/deploy-worker.yml` redeploys worker (+schema) on push to `worker/**` or `d1/**`.
- Deploys: Pages is git-connected (`public/`, build `scripts/stamp-release.sh` stamps `release.json`); `./deploy/deploy.sh` runs D1 schema+migrations, stamps, Pages deploy, worker deploy; `./deploy/verify.sh` checks markers, non-empty list, agent freshness ≤12h.

## 2. End-to-end walk-through

Signal → proposal → brief → vet → experiment → decision. Hops (file:line):

1. Cron fires `scheduled()` → `runResearch(env, "cron")` (`worker/src/index.js:487-489`, `:182`); manual path `POST /run` returns 202 and runs the same pass in `waitUntil` (`worker/src/index.js:543-552`).
2. Collect: `hnSignals()` ×4 queries, `redditSignals()` ×3, `githubSignals()` ×2 (`worker/src/index.js:48`, `:72`, `:96`, `:217`, `:116` slices GitHub to 2) → one batched `INSERT OR IGNORE` (`worker/src/index.js:222-227`).
3. Stale sweep (>30d → noise, `worker/src/index.js:235-240`) → take oldest 6 unprocessed (`worker/src/index.js:242-244`) → exact-URL supports pre-pass, no AI (`worker/src/index.js:250-267`, pure `exactUrlTarget` `:153-163`).
4. Classify: one Mistral NDJSON call over ≤6 signals vs top-60 list (`worker/src/index.js:277-294`, `aiComplete` `:121-138`) → verdict loop inserts ≤2 `researching` rows capped ≤6000 with `UNREVIEWED` (`worker/src/index.js:300-368`, cap `worker/src/lib.js:21-32`, estimates `worker/src/index.js:165-180`, inflow cap `:16`, `:317`).
5. Brief: cron only — 1 bare row (top-scored, or oldest-unreviewed past 48h) + optionally 1 extra oldest bare row past 48h (`worker/src/index.js:370-475`); manual runs skip via `briefDeadline = -1` (`worker/src/index.js:215`); single run-log write (`:476-478`).
6. Human vets in dashboard: `refresh()` boot (`public/app.js:1135-1157`) → client-side oldest-first review list (`public/app.js:230-250`) → Vet / Vet-&-log-starter / Kill (`public/app.js:393-411`, `:419-449`, `:451-475`) → `PATCH /api/opportunities/:id` clears marker, lifts cap, tags `[date vetted]` (`functions/api/[[path]].js:123-160`).
7. Experiment: log/start/lose/win from board or drawer (`public/app.js:992-1044`, `:536-598`) → `POST/PATCH /api/experiments` with closure gate (won/lost require `result` + `post_mortem`, stamps `started_at`/`ended_at`, cents + `revenue_source`, outcome ledger line into parent notes) (`functions/api/[[path]].js:236-340`); header counts decisions/vetted/revenue from `/api/health` (`functions/api/[[path]].js:355-392`).
8. Scores recompute on every write via shared `effectiveScore` imported from the worker lib (`functions/api/[[path]].js:10,66,108,148`).

Where it most often breaks or goes silent: the human bottleneck — 11 unreviewed, oldest 165.8h (~6.9d), `vetted_last_7d = 0`, `decisions_last_7d = 0`, 19/27 rows brief-less, 2 planned experiments with zero running. Silent machine drops compound it: malformed brief JSON is swallowed (`worker/src/index.js:428` `catch {}`), invalid verdicts are dropped or marked noise without surfacing (`worker/src/index.js:300-315`), the brief pass self-skips past deadline (`worker/src/index.js:378`), and the manual path must fit `waitUntil`'s ~30s cap (`worker/src/index.js:7-11`).

## 3. Health signals measured here

- Test suite (`npm test` = `node --test worker/src/lib.test.js worker/src/index.test.js functions/api/api.test.mjs public/tab-icon.test.mjs public/dashboard.test.mjs`): exit 0 — `# tests 199, # suites 71, # pass 199, # fail 0, # cancelled 0, # skipped 0, # duration_ms 1851.298398`. Windows baseline per brief: `duration_ms 406.9882`. Same green; slower here is sandbox overhead. Warnings only: `MODULE_TYPELESS_PACKAGE_JSON` (add `"type": "module"`) and an experimental-proxy notice.
- `node --check`: exit 0 on `public/app.js`, `worker/src/index.js`, `worker/src/lib.js`, `functions/api/api.test.mjs`. The router `functions/api/[[path]].js` was not checked directly (shell glob chars); its parse is proven by the green suite, which imports it (`functions/api/api.test.mjs`, 20 API suites green).
- `python3 -m compileall`: N/A — zero `*.py` files in the repo (glob search, no matches). Python appears only as JSON one-liners inside `deploy/deploy.sh:39-41` and `deploy/verify.sh:39,43,51`.
- Live surfaces: `_night/live/aimoney_pages_dev.html` is text-identical to `public/index.html` (`diff --strip-trailing-cr -q`, exit 0). Light palette only (`color-scheme: light`, `public/styles.css:4`; no `prefers-color-scheme`/`data-theme`/theme-toggle in served CSS/JS/HTML — those strings appear only inside the guard tests that forbid them). `<link rel="icon" href="/favicon.svg">` + `<meta name="theme-color">` (`public/index.html:9-10`); inline `$` brand mark (`public/index.html:16`) matching `public/favicon.svg` (285 bytes, one line, under 2 KB). Guard suite `public/tab-icon.test.mjs` passes 5/5 inside `npm test`. All 5 standing surface rules hold — no surface-rule findings this round. `Loading …` rows are JS-boot states only, not placeholders.
- Live health (`_night/live/aimoney_pages_dev_api_health.html`, rev `d1aa266`): `{"ok":true,"db":"up","opportunities":27,"unreviewed":11,"bare_without_brief":19,"experiments_by_status":{"planned":2},"hours_since_last_ok_run":4.1,"oldest_unreviewed_age_h":165.8,"decisions_last_7d":0,"revenue_last_7d":0,"revenue_total":0,"spent_total":0,"vetted_last_7d":0,"vetted_no_experiment":0,"noise_24h":0}`. Worker fresh (4.1h, inside the 12h gate); every decision counter zero.
- Dead code (all verified present): `BRIEF_DEADLINE_MS` defined but never referenced (`worker/src/index.js:21` vs live `briefDeadline` at `:215`); unused `scoreOf` import (`worker/src/index.js:140`, no other use in file); `GITHUB_QUERIES.slice(0, 2)` silently drops the third query (`worker/src/index.js:116` vs `:28`); `appendKeepNewest` has zero production callers (`worker/src/lib.js:36-39`, tests only); five dead toast gates after modal returns (`public/app.js:396,454,539,558,584`, each preceded by an identical `if (!state.token) return openAdminModal(...)` and self-commented as superseded); `GET /api/briefs` (`functions/api/[[path]].js:162-169`) has no first-party runtime caller (dashboard renders briefs from the detail payload `public/app.js:725-746` and list excerpts); `reviewBriefLine` wraps its body in a pointless inner block (`public/app.js:182-185`); `cleanUnreviewed`'s second replace can never match after the first global replace (`public/app.js:390`).
- Duplicated logic: `clamp10` in `functions/api/[[path]].js:12-16` vs `worker/src/lib.js:4-7` (API already imports `effectiveScore` from lib but not `clamp10`); classify prompt built twice (`worker/src/index.js:277-287` vs `/debug-classify` `:522-531`); brief prompt+parse+insert twice (`worker/src/index.js:394-428` vs extra-brief `:442-471`); `inlineWinClose` (~60 lines, `public/app.js:325-387`) mirrors `inlinePostMortem` (`:281-319`); three separate `#board` click listeners (`public/app.js:1048,1057,1066`); outcome-ledger append differs slightly between create (`functions/api/[[path]].js:274-283`, no parent `updated_at` bump) and update (`:320-329`, bumps it); `centsDollars` (API `:20`) vs `moneyCents` (`public/app.js:53`) — documented-deliberate mirror; `UNREVIEWED` as SQL/string literals while exported `UNREVIEWED_MARKER` (`worker/src/lib.js:21`) is used only inside lib; vetted tag string-coupled (`[date vetted]` written at `public/app.js:400,424`, counted via `LIKE '%vetted]%'` at `functions/api/[[path]].js:369-370`).
- TODO density: **0** in source — regex `TODO|FIXME|XXX|HACK|BUG` across `public/ functions/ worker/ scripts/ deploy/ d1/` returns nothing.
- Note on acceptance: `git status --short` showed every tracked file as `M` (CRLF line-ending normalization) before anything was written; those flags predate this audit. This audit created only `AUDIT-2026-09-20-round2.md` and edited nothing.

## 4. Ranked findings (max 8)

Lane metric (aimoney): experiments reaching a decision (won/lost + post-mortem) per week, and vetted proposals that become experiments; unreviewed backlog drained. Current values from the repo's own health endpoint today: `decisions_last_7d: 0`, `vetted_last_7d: 0`, `unreviewed: 11` (oldest 165.8h ≈ 6.9d), `bare_without_brief: 19/27`, `experiments_by_status: {planned: 2}` (zero running/won/lost), `revenue_total: 0`. Findings ranked by phone-clear speed first, then worker self-pacing (reversible, no status moves), then the concrete $0 experiment. No surface-rule findings (see §3).

### F1. Every phone action refetches all four endpoints though each dirties at most two

Evidence — `public/app.js:1135-1142`: `refresh()` always fetches `/api/opportunities`, `/api/experiments`, `/api/runs?limit=20`, `/api/health` in parallel, and 11 call sites invoke the full `refresh()` after their write (`public/app.js:407,445,468,546,568,594,852,871,890,987,1039`). But: vet/kill/add/save/rescore touch only opportunities+health; Start touches only experiments+health; runs change only on cron ticks or the manual trigger, never on vet/kill/start/win/lose.

Why it costs: every single tap on the sub-minute phone path pays 2–3 round-trips whose output provably did not change — the Research log (20 rows) is re-read after every vet, the experiment board after every kill — slowing each repaint of the decision the owner just made.

Fix: parameterize `refresh()` by target set: vet/kill/add/save/rescore refetch opportunities+health (+ the client-side review derive); Start refetches experiments+health; win/lose refetch opportunities too because closing appends the outcome-ledger line to parent notes (`functions/api/[[path]].js:320-329`); runs refetch only on boot, the delayed post-triage refresh, and Research-tab switch. Touch `public/app.js` and `public/dashboard.test.mjs` (pin each action's fetch set, including the win/lose ledger trap). Size M. Risk low-medium — read-only scoping, but a dropped refetch paints stale state until the next full refresh.

### F2. `/api/health` runs 13 sequential D1 queries plus a release.json subrequest per call

Evidence — `functions/api/[[path]].js:356-372`: the health branch awaits 13 separate selects in sequence (count, unreviewed, bare, exp-by-status, lastOk, oldestUnreviewed, decisions, revenue_7d, revenue_total, spent_total, vetted, vettedNoExp, noise), then `fetch(new URL("/release.json", url.origin))` at `:386-390` on every call. Health is fetched by every dashboard `refresh()` and twice by `deploy/verify.sh` (`:32` check + `:51` freshness).

Why it costs: the hottest endpoint pays a dozen D1 round-trips where independent pairs scan the same rows — `decisionsRow`+`revenueRow` both scan won/lost-closed-in-7d (`:365-366`), `revenueTotalRow`+`spentTotalRow` both scan all won/lost (`:367-368`), `unreviewedRow`+`oldestUnreviewed` both scan UNREVIEWED rows (`:357`,`:361`) — plus a same-origin subrequest for a deploy-static file, on every tap's refresh.

Fix: merge the paired scans (`COUNT(*)`+`SUM()` in one statement each; `COUNT(*)`+`MIN(created_at)` for the unreviewed count/oldest pair) and issue the remaining independent selects via one `env.DB.batch(...)` as the worker already does for inserts (`worker/src/index.js:222-227`); cache the release.json revision in module scope (static per deploy). Keep every response key byte-identical. Touch `functions/api/[[path]].js` and `functions/api/api.test.mjs`. Size M. Risk low-medium — SQL-only change, existing health-key tests pin the contract.

### F3. Start-here strip spends a 3-select detail fetch on data the list already carries

Evidence — `public/app.js:123-130`: when the top pick has no cached brief text, the strip fires `api(\`/api/opportunities/${top.id}\`)` just to compute `firstStepsFirstLine(d.briefs[0])`. But the list payload already includes `(SELECT b.first_steps ... ORDER BY b.version DESC LIMIT 1) AS brief_first_steps` (`functions/api/[[path]].js:59`) — the same latest-brief row the detail call reads. Server-side the detail call costs 3 sequential selects (row + briefs + experiments, `functions/api/[[path]].js:73-83`).

Why it costs: every top-pick change (i.e. after every vet/kill that re-ranks #1) burns a needless round-trip before the owner sees his next action — the exact "everything it depends on in front of it" path — plus a `topBriefText` cache (`public/app.js:8,102-130`) that exists only to serve that redundant fetch.

Fix: use `firstStepsFirstLine({ first_steps: top.brief_first_steps })` directly in `renderStartHere` and delete the `topBriefText` fetch/cache (`public/app.js:8,102-130`, update the comment at `:91-96`). Touch `public/app.js` and `public/dashboard.test.mjs`. Size S. Risk low — identical excerpt source, null-safe like the review decision line (`public/app.js:166-175`).

### F4. Vet-&-log-starter PATCHes the same row twice with an experiment POST between

Evidence — `public/app.js:428-443`: `vetAndLogStarter` sends `PATCH /api/opportunities/:id {notes}` (vet tag), then `POST /api/experiments` (starter), then `PATCH /api/opportunities/:id {status: "testing"}`. The first and third calls write the same row seconds apart; each is a D1 UPDATE plus a score recompute (`functions/api/[[path]].js:123-160`), and the first PATCH's returned score is discarded.

Why it costs: the flagship one-tap path (vet → experiment → testing) pays three serial round-trips where two suffice, adding a full phone-network round-trip of latency to the tap designed to drain the 11-deep queue from the top.

Fix: send one `PATCH {notes, status: "testing"}` plus the `POST /api/experiments` (the two are independent — the POST needs only the known `opportunity_id` — so they can even run in parallel); keep the Start-shortcut toast. Touch `public/app.js` and `public/dashboard.test.mjs` (extend the vet-&-log-starter suite to assert two calls, vet tag + testing flip both present). Size S. Risk low — same two writes the human makes today, one fewer round-trip.

### F5. Each run fetches and stores ~72 signals but triages 6; the rest queue, then sweep to noise

Evidence — `MAX_SIGNALS_PER_SOURCE = 8` (`worker/src/index.js:14`) × 4 HN + 3 Reddit + 2 GitHub queries (`:25-28`, `:116` slices to 2) = up to 72 collected and batch-inserted per run (`:217-227`), while triage takes `MAX_AI_SIGNALS = 6` (`:15`, `:242-244`) and inserts at most 2 (`:16`, `:317`). At 4 runs/day that's ~288 stored vs 24 triaged; the overflow ages out via the 30d sweep (`:236-240`) having consumed fetch time, insert batch, and D1 rows for nothing — and it fattens the `signals` table that F6 scans in full on every tick.

Why it costs: external fetch volume (9 HTTP requests against the wall clock), D1 growth (~8k swept rows/month at max), and compounding per-run cost in the exact-URL pre-pass — all for signals that demonstrably never get triaged (inflow 12× drain).

Fix: gate collection on queue depth — `SELECT COUNT(*) FROM signals WHERE processed = 0` first and skip the source fetches when unprocessed depth exceeds ~2 runs' worth (12), letting the take at `:242` drain the queue; alternatively cut `MAX_SIGNALS_PER_SOURCE` to 2–3 to match consumption. Nothing of value is lost: skipped signals are ones the 30d sweep would have noised. Touch `worker/src/index.js` and `worker/src/index.test.js`. Size M. Risk low — collection is idempotent (`INSERT OR IGNORE`), triage order unchanged, no status moves.

### F6. Exact-URL pre-pass loads two full tables to match ≤6 signals, with no index on either column

Evidence — `worker/src/index.js:251-256`: every run with fresh signals runs `SELECT id, source_url FROM opportunities WHERE source_url != ''` and `SELECT url, opportunity_id FROM signals WHERE opportunity_id IS NOT NULL AND url != ''`, then loops `exactUrlTarget` (`:153-163`) per signal. Cost grows with both tables on every tick, yet at most 6 URLs are ever matched — and neither `opportunities.source_url` nor `signals.url` has an index (`d1/schema.sql:28-29,85` cover status/score, category, processed/created_at only).

Why it costs: two unbounded full-table scans per run (4×/day forever) for a lookup that should be O(1) per signal; as F5's swept-but-stored signals accumulate toward the 30d horizon this is the fastest-growing per-run cost on the wall-clock-pressured pass.

Fix: replace the bulk loads with per-signal indexed lookups (`SELECT id FROM opportunities WHERE source_url = ? LIMIT 1`, same shape for signals) and add `CREATE INDEX IF NOT EXISTS` on both columns via `d1/schema.sql` plus a `d1/migrate-*.sql` (deploy applies idempotently, `deploy/deploy.sh:34-38`). Touch `worker/src/index.js`, `d1/schema.sql`, new migration, `worker/src/index.test.js`. Size M. Risk low-medium — same match semantics (`exactUrlTarget` unit tests pin them); migration is additive and idempotent.

### F7. Verdict loop issues up to ~12 sequential D1 writes; the collect phase already proved batching

Evidence — `worker/src/index.js:300-368`: per signal the loop awaits its writes one by one — invalid-action UPDATE (`:307`), new-path INSERT + signal UPDATE (`:328-342`), collision SELECT + 2 UPDATEs (`:347-351`), supports 2 UPDATEs (`:358-364`), noise UPDATE (`:366`) — up to ~12 serial D1 round-trips for 6 signals. The same file already proved the fix for collection: "ONE batched round-trip instead of ~24 sequential inserts (9s -> 0.5s)" (`worker/src/index.js:220-227`).

Why it costs: serial D1 latency on the pass that must fit the `waitUntil` wall clock (`worker/src/index.js:7-11`), paid on every run with fresh signals — repeated work in the exact shape this codebase already eliminated once.

Fix: keep the dependent ops ordered (INSERT → `last_row_id` for its signal UPDATE; collision SELECT before its UPDATEs) and accumulate every independent signal-UPDATE + notes-append into one `env.DB.batch([...])` after the loop body. Touch `worker/src/index.js` and `worker/src/index.test.js`. Size M. Risk low-medium — same writes, same order of dependents; keep the best-effort `.catch(() => null)` shape on the notes appends and pin processed/opportunity_id outcomes in tests.

### F8. The $0 spec-ad sprint still sits unpressed: the concrete 14-day start

Evidence: `d1/seed.sql:67-71` logs `Spec-ad sprint: 10 brands, 10 free ads` as `planned`, budget `'$0 + 10 hours'`, metric `'replies; pilots closed'`, target `'>=3 replies; >=1 pilot at >=$500'`; `public/app.js:534-535` names it the first Start candidate ("a human still presses it"); live health shows `experiments_by_status: {"planned": 2}` with zero running/won/lost and every money counter at 0.

Why it costs: decisions/week cannot move until something runs, and the cheapest possible start — $0, one press — has been idle across four consecutive zero-decision snapshots while the board accumulated visibility. No code is missing for the start itself.

Fix (owner action, proposed concretely): press Start on the spec-ad card this week; send 10 finished spec ads to 10 real DTC supplement brands built from public assets; at day 7 record the reply count, at day 14 record pilots; close won (≥1 $500 pilot, amount + source via the one-click Win row, never invented) or lost (reply count as the result line). Files to touch: none — press Start. Size S (one press + 10h of sending). Risk: 10 hours, $0 spend; never mark it decided without the reply/pilot counts.

## 5. What NOT to change

- Agent never moves status: "The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed)." (`worker/src/index.js:4-5`; also `README.md:72`: "`researching → testing` is a human decision".) F5–F7 pace and cheapen the pass; none moves status.
- UNREVIEWED score cap: "its EFFECTIVE score is clamped below the human seeds" (`worker/src/lib.js:18-20`, `UNREVIEWED_SCORE_CAP = 6000`, `:22`). Do not lift or retune while the backlog is unreviewed.
- New-proposal inflow cap: "Each run inserts at most 2 new proposals (inflow ≤ brief capacity)" (`README.md:76`; `MAX_NEW_PER_RUN = 2`, `worker/src/index.js:16`). F5 trims collection ahead of it; the cap itself stays.
- Closure gate: won/lost require `result` + `post_mortem` (`functions/api/[[path]].js:247-252,310-314`); never invent revenue (`revenue_cents`/`spent_cents` default 0, `:258-260`) and never auto-apply the suggested rescore ("never auto-applied", `README.md:74`).
- Manual runs skip briefs by design: "Manual `Run triage now (briefs on cron)` collects and triages only" (`README.md:77`; `briefDeadline = -1`, `worker/src/index.js:215`; 202 carries `briefs_skipped:true`, `:551`). Do not "fix" by briefing on manual.
- Stuck-run reaper and run log: runs left `running` past 30 min are declared dead by the next run (`worker/src/index.js:186-191`); every pass logs exactly one finish row (`:476-478`). F7 batches verdict writes only, never the run log.
- Token-gated writes: admin `Bearer` checks (`functions/api/[[path]].js:24-32`, worker `/run` `:544-546`, dashboard modal gates e.g. `public/app.js:394`); token rotation stays a human deploy step (`README.md:85-88`: set Pages env + worker secret, redeploy both, re-enter in dashboard). Never touch credentials, `.env`, deploy scripts, or CI config for these cuts.
- Human-owned decisions: vet/kill/testing/scaling moves, post-mortem text, revenue amounts and sources — all require the owner; the 30d signal sweep (`worker/src/index.js:235-240`), killed-rows-stay-listed rule (`README.md:63-64`), and idempotent seed-if-empty deploy (`deploy/deploy.sh:30-47`) stay as-is.
- Anything needing a login, credential, payment, or a human decision: Cloudflare deploys, `CLOUDFLARE_API_TOKEN`, sending the spec ads, pricing a pilot, vet/kill calls, closing experiments. This audit changed no code and read no secrets.

## 6. Proposed next tasks (2–4)

1. `Split refresh per action; runs only on boot and triage` — files: `public/app.js`, `public/dashboard.test.mjs`. Acceptance: vet/kill/add/save/rescore fetch opportunities+health only; Start fetches experiments+health; win/lose also refetch opportunities (ledger trap, `functions/api/[[path]].js:320-329`); runs fetched on boot, delayed post-triage refresh, and Research-tab switch; per-action fetch sets pinned in tests; `npm test` green.
2. `Merge health paired scans; batch the rest; keys identical` — files: `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Acceptance: identical health JSON including every key `verify.sh` needs; decisions+revenue, lifetime totals, and unreviewed count+oldest each merged to one scan; remaining independents in one batch; release.json revision cached per deploy; `npm test` green.
3. `Start-here strip reads brief_first_steps; drop detail fetch` — files: `public/app.js`, `public/dashboard.test.mjs`. Acceptance: the strip issues zero `/api/opportunities/:id` calls; next-action text identical including the bare-row fallback; `topBriefText` state and its fetch block removed; `npm test` green.
4. `Vet-&-log-starter PATCHes once; merge notes and status` — files: `public/app.js`, `public/dashboard.test.mjs`. Acceptance: one tap sends one opportunity PATCH carrying both the vet tag and `testing` plus one experiment POST; Start-shortcut toast kept; token gating unchanged; call count and both fields pinned in tests; `npm test` green.
