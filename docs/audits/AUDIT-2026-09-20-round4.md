# Audit 2026-09-20 round 4 — aimoney (read-only)

Clone root: `/root/coding-projects/_workspace/trackb-aimoney-r4`. No existing file edited, no network, no installs. Only this file created.

## 1. What this project is and how it runs

- Purpose: AIMoney Lab — ranked AI-money opportunities with research briefs and experiments; the agent proposes, a human vets and tests.
- Entry points: `public/index.html` + `public/app.js` (dashboard), `functions/api/[[path]].js` (D1-backed REST API), `worker/src/index.js` (research agent).
- Live surfaces: `https://aimoney.pages.dev/` (dashboard), `/api/health`, `/api/opportunities`, `/api/runs`, worker `https://aimoney-research.levitinvlad.workers.dev/`.
- Scheduled jobs: worker cron `0 */6 * * *` (every 6h, collect + triage + briefs) and manual `POST /run` (202, triage-only, `briefs_skipped:true`).
- Deploys: Pages Git-connected (`public/` + `scripts/stamp-release.sh`) plus CI `.github/workflows/deploy-worker.yml` (schema + shared migrations + worker) or manual `deploy/deploy.sh`, gated by `deploy/verify.sh`.

## 2. End-to-end walk-through

Signal to decision, with the hop where it most often goes silent at the end.

1. Collect: `worker/src/index.js:49` `hnSignals`, `:78` `redditSignals`, `:106` `githubSignals` via `timedJson` (`:37`, 6s timeout covering the body read). Per-query throw marks the source; all-failed names it in `src_fail`.
2. Store: `:354-359` one batched `INSERT OR IGNORE INTO signals`, then heartbeat `:360-363` so the dashboard shows `phase:collected`.
3. Sweep: `:368-372` unprocessed signals older than 30d become noise (`stale:N`), so ancient backlog cannot wedge the oldest-first take.
4. Take: `:374-376` `SELECT * FROM signals WHERE processed = 0 ORDER BY id ASC LIMIT 6`.
5. Exact-URL pre-pass (no AI): `:382-408` via pure `exactUrlTarget` (`:168`); a fresh URL matching an opportunity `source_url` or a linked signal URL links as supports (notes newest-kept, no status move).
6. Classify (one AI pass): `:419-430` `buildClassifyPrompt` (`:272`) + `aiComplete` (`:136`, 60s/12s timeout, retries 1 on cron / 0 manual), parsed by `parseJsonLines` (`worker/src/lib.js:62`, NDJSON + `repairJson` for `\_`).
7. Gates: `:439-450` bare-without-brief > 10 caps inserts to 1/tick; unreviewed > 10 pauses inflow to 0/tick (`maxNewThisRun = 0`). Overflow new-verdicts stay `processed = 0`.
8. Verdict writes: `:458-527` accumulated then `flushVerdictWrites` (`:291`, batch with per-write fallback, failures as `verdict:N_failed`). New rows `INSERT` (`:486-500`) with `UNREVIEWED` (`:496`) and capped `effectiveScore`; slug collision links as supports (`:501-513`).
9. Briefs: main `:539-575` (top-scored, or oldest-unreviewed-first past 48h) plus extra `:582-617` when the oldest unreviewed exceeds 48h, via `buildBriefPrompt` (`:202`), `parseBriefJson` (`:213`), `insertBrief` (`:224`, never stores empty), poison rotation `:248-265` (`brief:skipped:N`).
10. Finish: `:620` single `finish("ok", …)` carrying `brief:mode`, `stale:N`, `src_fail:…`, `brief:failed`, `verdict:N_failed`; errors `:622-630` finish `error` plus `console.error("cron-failed", …)` tail marker.
11. Dashboard review: `public/app.js:242` `refreshReview` (client-side `deriveReviewList` `:239`, API fallback only at `>= 200` rows), `:189` `renderReview` with decision line (`:167` capital + next + source) and brief line (`:181` summary or `No brief yet`) plus Vet / Vet-&-starter / Kill (`:200-202`); `:103` `renderStartHere` with Vet/Kill for unreviewed top picks (`:124-125`); `:254-261` review chip count + oldest age from `/api/health`.
12. Vet (the path that moves unreviewed to vetted): `public/app.js:429` `vetOpportunity` → `:419` `fetchDetailForWrite` (token-gated `GET /api/opportunities/:id`) → `:434` inner → `:409` `vettedNotes` (clears `UNREVIEWED`, appends `[YYYY-MM-DD vetted]`) → `PATCH /api/opportunities/:id`. Starter variant `:457` adds a planned experiment and flips the row to `testing`.
13. API writes: `functions/api/[[path]].js:209` `updateOpportunity` (text bounds, status/range guards, `effectiveScore`), `:326` `createExperiment` / `:390` `updateExperiment` (won/lost require `result` + `post_mortem`, `started_at`/`ended_at` stamps, outcome ledger `:427-436`, cents clamps, `revenue_source` retry tolerance).
14. Health: `:474-635` 12-probe batch (`:494-507`) with per-probe isolation fallback (`:517-546`, failures named in `health_probe_failures` + column-only `health_probe_detail`), lazy self-migration (`:554-571`), `last_vetted` JS parse (`:597-604`), payload `:635` (`ok:false` + nulls only on total outage).

Where it most often breaks or goes silent: hop 12, the human Vet press. Nothing automated was ever supposed to vet (see F1): the worker creates `UNREVIEWED` rows and never clears them, cron ticks succeed (`hours_since_last_ok_run` 1.8) while `vetted_last_7d` stays 0 and the oldest unreviewed ages 175.5h and rising. Second: the money probes (hop 14) return null because `revenue_cents`/`spent_cents` never reached live D1 and the self-migration is disabled (see F2).

## 3. Health signals measured here

- Test suite: `npm test` (`node --test` over `worker/src/lib.test.js`, `worker/src/index.test.js`, `functions/api/api.test.mjs`, `d1/migrations.test.mjs`, `deploy/deploy.test.mjs`, `public/tab-icon.test.mjs`, `public/dashboard.test.mjs`) → `tests 345, suites 117, pass 345, fail 0, cancelled 0, skipped 0`, `duration_ms 90599.21`, exit 0, `node v22.22.3`. Real run in this session, no narrowing.
- Parse: `node --check public/app.js` → exit 0 (only the sandbox `UNDICI-EHPA` proxy warning on stderr). `python3 -m compileall`: not applicable, no Python source in this repo; the JS equivalent (`node --check` plus the `verify.sh` dashboard-appjs parse gate) is what guards the bundle.
- Dead code: none in shipped source. `scoreOf` deduped (API imports `effectiveScore` from `worker/src/lib.js`, `functions/api/[[path]].js:83`); brief/classify/insert prompts shared (`buildBriefPrompt`, `parseBriefJson`, `buildClassifyPrompt`, `insertBrief`); hygiene suite drops the unenforced deadline, unused import, and slice-or-string mismatch. `console.*` in shipped source is only the three deliberate `console.error("cron-failed", …)` markers (`worker/src/index.js:628,640,704`); no `debugger`. Positive control: the same regex matches the test harnesses that capture them (`worker/src/index.test.js:626-627,796-797`), so the three is real.
- Duplicated logic: none material. `effectiveScore` (`worker/src/lib.js:29`) and `tokensMatch` (`:34-45`) are single-shared (3 worker checks + API); `centsDollars` (`functions/api/[[path]].js:82`) mirrors `money()` in `public/app.js` by documented contract with tests on both sides.
- TODO density: zero in shipped source. Regex `TODO|FIXME|HACK|XXX` over the repo hits only `docs/audits/*.md` prose. Positive control: the same search tool and mode matches `UNREVIEWED` 20+ times across `worker/src` + `public/app.js` and `revenue_cents` across worker + API + D1, so the zero is real.
- Surface rules: light-only (`public/styles.css:4` `color-scheme: light`, no `prefers-color-scheme`/`data-theme`/toggle in `public/` — same-regex control matches `color-scheme: light`, so the absence is real); favicon linked (`public/index.html:9-10`, `public/favicon.svg` 269 bytes, 32×32 `$` on `#0d6b3f`); brand mark inline in header (`public/index.html:16`, same geometry/accent/glyph); guard test `public/tab-icon.test.mjs` passes inside the 345.
- Working tree: `git status --short` empty before this file; `.gitattributes` pins `eol=lf`, no CRLF dirt.
- Live snapshot read from `_night/live/aimoney_pages_dev_api_health.html:1` (rev `eadb920`): `ok:true, db:up, opportunities:27, unreviewed:11, bare_without_brief:19, experiments_by_status:{planned:2}, hours_since_last_ok_run:1.8, oldest_unreviewed_age_h:175.5, decisions_last_7d:0, revenue_last_7d:null, revenue_total:null, spent_total:null, vetted_last_7d:0, last_vetted:null, vetted_no_experiment:0, noise_24h:0, health_probe_failures:[revenue_week,revenue_lifetime], health_probe_detail:{…:revenue_cents}, schema_missing_columns:[revenue_cents,spent_cents], schema_migration:disabled…`. Dashboard shell `_night/live/aimoney_pages_dev.html` (121 lines) matches `public/index.html`: light, favicon, brand, agent pill, tabs, review chip.

## 4. Ranked findings (max 8)

Lane metric (aimoney): experiments reaching a decision (won/lost + post-mortem) per week, and vetted proposals becoming experiments; unreviewed backlog drained. Current: `decisions_last_7d` 0, `vetted_last_7d` 0, `vetted_no_experiment` 0, unreviewed 11 (oldest 175.5h / 7.3d, rising 1d/d), bare-without-brief 19/27, experiments `{planned: 2}`, `last_vetted` null, `hours_since_last_ok_run` 1.8.

Money-first (owner directive), in this project's own numbers. This project is a tool the owner uses to rank and test AI-money ideas, not a product he sells; rank by owner time saved and decisions/week, measured the same way. Earned to date: none measured — `revenue_total` null, `revenue_last_7d` null, `spent_total` null (unknown, not zero; the live D1 lacks the money columns so the probes cannot run). No experiment closed won/lost in 7d (`decisions_last_7d` 0); no row ever vetted (`last_vetted` null). Last krone arrived: never recorded. Single step between now and the next payment: vet the 11 rows, log one $0-capital starter experiment, run it to won/lost with a human-entered `revenue_cents` + post-mortem via the inline Win/Lose close. Measured conversion at that step: 0/11 vetted (0%), 0/2 planned started (0%), 0 decisions/week. Honesty: no projection presented as result, no rate × volume multiplication, no attempt counted as outcome (signals seen ≠ proposals, proposals ≠ vetted, planned ≠ running). The bottleneck outside the code is stated in F1.

### F1. Nothing automated was ever supposed to vet — the 11-row queue waits on a human press

Evidence. `worker/src/index.js:4-5`: `The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed).` Worker creates the marker (`:496`: `` `… — UNREVIEWED, scores capped until a human vets it …` ``) and every other worker `UNREVIEWED` hit is create/count/select (`:448-449,542,550,591,595`) — no worker path clears it (positive control: the same search returns those 8 creation/count sites, so the absence of a clearing path is real). `README.md:71`: `A human admin vets each row: "Vet" clears the UNREVIEWED marker … and appends a [YYYY-MM-DD vetted] tag`; `README.md:72`: `The agent never moves status.` The moving path is a manual dashboard button: `public/app.js:429` `vetOpportunity` (and `:457` `vetAndLogStarter`) via shared `vettedNotes` (`:409`: `` `${cleanUnreviewed(notes)}\n[${day} vetted] Human vetted; cap lifted.` ``) → `PATCH /api/opportunities/:id`. Live: `vetted_last_7d` 0, `last_vetted` null, unreviewed 11, oldest 175.5h, while `hours_since_last_ok_run` is 1.8 — something runs (cron triage + briefs) and yields no verdicts by design, not by failure.

Why it costs: the lane metric is frozen at every stage (0 vetted/week → 0 started → 0 decisions/week, 2 planned stuck), inflow is paused at 0/tick while unreviewed > 10 (`worker/src/index.js:448-449`), and 19/27 rows lack the brief that makes a sub-minute vet possible. Five rounds improved the machinery; the queue never moved because the move is human-gated and the human has not pressed.

Fix: add a queue-triage mode to the review view — `V` vets the focused row and auto-advances, `K` opens the inline post-mortem and killing advances on confirm — reusing `fetchDetailForWrite`, `vettedNotes`, toasts, and `refreshReview`, with the existing buttons untouched and no bulk/auto path. Pin it in `public/dashboard.test.mjs` (handlers, auto-advance, token gate, no auto-vet). Touch `public/app.js`, `public/dashboard.test.mjs`. Size M. Risk low (reversible token-gated PATCHes, human presses every verdict, no status auto-moves).

### F2. Live money legs are null — the columns never reached D1 and the migration is disabled

Evidence. Live `_night/live/aimoney_pages_dev_api_health.html:1`: `"revenue_last_7d":null,"revenue_total":null,"spent_total":null,"health_probe_failures":["revenue_week","revenue_lifetime"],"health_probe_detail":{"revenue_week":"revenue_cents","revenue_lifetime":"revenue_cents"},"schema_missing_columns":["revenue_cents","spent_cents"],"schema_migration":"disabled (set ALLOW_SCHEMA_MIGRATION=1 to add missing columns)"`. The two failing probes are the only ones reading money: `functions/api/[[path]].js:501-502` (`SUM(revenue_cents)`, `SUM(revenue_cents/spent_cents)`). `d1/schema.sql:5` is `CREATE TABLE IF NOT EXISTS` (no-op on the existing table); the ADD COLUMNs exist only in `d1/migrate-2026-09-20-experiment-cents.sql:5-6` (+ `revenue_source` in `d1/migrate-2026-09-20-revenue-source.sql:5`), applied by CI `.github/workflows/deploy-worker.yml:27,33-34` and `deploy/deploy.sh:33,37` via `deploy/apply-d1-migrations.sh` — which never ran against live D1 (no `CF_API_TOKEN`/`CF_ACCOUNT_ID` repo secrets, fail-fast `:20-26`). The in-worker fallback is deliberately off: `functions/api/[[path]].js:53` `if (String(env.ALLOW_SCHEMA_MIGRATION || "") !== "1")` → report missing + disabled, change nothing.

Why it costs: earned-to-date is unknown rather than zero, so the money-first question cannot be answered from the project's own data; lifetime and weekly money stay dark while the rest of the payload reports. The decisions COUNT split (`:500`, no money column) already saved `decisions_last_7d` (= 0, not null) — the money legs are the only remaining nulls.

Fix: no code change; the path is already correct (isolation fallback, column-only detail, ADD-only self-migration, sorted shared migrations, convergence tests — all in the 345 green). The owner either sets `ALLOW_SCHEMA_MIGRATION=1` as a Pages env var, after which the next `/api/health` PRAGMAs `experiments`, applies exactly the two ADD COLUMNs one at a time, and re-runs the failed money probes on the same call (second run a clean no-op); or adds the two Cloudflare repo secrets and redeploys so CI applies the migrations. One variable, one decision — see §5 for the exact lines. Touch no repo files. Size S. Risk none (ADD COLUMN with DEFAULT cannot lose a row; unset behaviour is byte-identical to today).

### F3. Inflow-paused ticks re-spend the classify AI call on the same 6 signals every 6h

Evidence. `worker/src/index.js:448-449`: `if (unRow.n > 10) maxNewThisRun = 0`; `:474-475`: `if (newInserts >= maxNewThisRun) continue; // … overflow new-verdict signals stay processed = 0 for a later tick`; `:374-376`: fresh take is oldest-first `LIMIT 6`; `:425`: `parseJsonLines(await aiComplete(…))` spends 1-2 of 4 AI calls per tick. Live unreviewed is 11, so each of the 4 daily cron ticks re-takes the same oldest unprocessed signals, re-prompts, re-verdicts `new`, inserts 0, and leaves them unprocessed — about 28 wasted classify calls/week.

Why it costs: Workers AI spend, run time, and log noise for zero queue movement; the brief half of the tick (the useful half while paused, with 19 bare rows) still runs, but up to half the AI budget burns on repeat verdicts with a predetermined outcome.

Fix: when `maxNewThisRun == 0`, skip the classify AI call entirely — leave `fresh` unprocessed, append `inflow:paused` to the finish error line beside `stale:`/`src_fail:`, and still run the main + extra brief passes. Resume classify when unreviewed ≤ 10. Pin with an `index.test.js` case driving the real `runResearch` against a stubbed D1 (unreviewed 11 → 0 classify calls, ≥1 brief, overflow unprocessed; unreviewed ≤ 10 → classify as today). Touch `worker/src/index.js`, `worker/src/index.test.js`. Size S. Risk low (reversible, no status moves, briefs unaffected).

### F4. `last_vetted` probe fetches the full notes of every vetted row on each health call

Evidence. `functions/api/[[path]].js:506`: `SELECT notes FROM opportunities WHERE notes LIKE '%vetted]%'`; `:596-604`: JS `matchAll(/\[(\d{4}-\d{2}-\d{2}) vetted\]/g)` max over all returned rows. At 0 vetted rows (live) this is cheap; at hundreds of vetted rows × 8000-char notes it becomes megabytes per `/api/health` — the dashboard's hottest read plus the verify poll.

Why it costs: D1 egress and latency that grow with success (more vettes = slower health); the stall-age signal this probe exists to provide gets more expensive exactly as the queue starts moving.

Fix: select a bounded tail (`substr(notes, -500)`) since `vettedNotes` appends newest-last under the same 8000-char cap, keeping the JS regex max so every tag in the row still counts; or add an indexed `last_vetted` column updated on vet PATCH (migration + tag backfill). Pin in `functions/api/api.test.mjs`: a long-notes row still reports its newest tag while the probe transfers the bounded shape. Touch `functions/api/[[path]].js`, `functions/api/api.test.mjs` (plus one `d1/migrate-*` file if the column route is chosen). Size M. Risk low (read-only probe, null fallback preserved).

### F5. First five seconds: the 7.3-day stall hides below the masthead on a phone

Evidence. `public/index.html:13-36`: masthead (brand + `h1` + lede + agent pill + two buttons) then tabs + formula fill a phone viewport before any number renders. The review chip lives in the toolbar below it (`public/app.js:52`, count `:254-257`, age `:258-261` from `oldest_unreviewed_age_h`); the agent pill reports freshness (`agent: ok`), not backlog. The most important truth — 11 to review, oldest 7d, never vetted — requires a scroll on the surface the owner actually opens.

Why it costs: the owner opens daily, sees a green pill and the score formula, and misses the stall; the queue ages another day per day while the header reads healthy.

Fix: mirror `N to review · oldest Xd` into the agent-pill text/title from the cached health snapshot already painted at boot (`public/app.js:1305-1306`), with a click jumping to the review filter; keep live-refresh-wins and failed-refresh-keeps-cache (the existing pattern) and leave the dot + probe-failure tooltip untouched. Pin in `public/dashboard.test.mjs` (pill text from stubbed health + jump). Touch `public/app.js`, `public/index.html` (pill anchor), `public/dashboard.test.mjs`. Size S. Risk none (read-only, cached).

### F6. Release marker uses a short SHA and omits the package version

Evidence. `scripts/stamp-release.sh:6` and `deploy/deploy.sh:58`: `REV` cut to 7 chars; `public/release.json` carries `{project, revision, built_at}` with no `release`, while `package.json:2` versions the repo at `0.1.0` unstamped. `deploy/verify.sh:66-100` compares short == short, retries stale 6×10s, and fails HTML/unparsable/placeholder bodies immediately — the check is sound, the identifier is short. Single source of truth is preserved (`/api/health` rev comes from `release.json` via `cachedHealthRev`, `functions/api/[[path]].js:627-634`).

Why it costs: 7 hex chars (268M space) are fine under ~10k commits but ambiguous across forks and long history; version drift between the repo tag and the live surface is invisible. Low impact today, exactly the kind of staleness the live-revision gate exists to catch.

Fix: stamp the full 40-char SHA as `revision` plus the package version as `release` (keep the short form in the deploy log), with verify accepting full or short-prefix; or document short-SHA as deliberate for this single-repo scale in `deploy/public-surfaces.json`. Do not add `/build.json` — `release.json` is the one checked source. Pin in `deploy/deploy.test.mjs` (full SHA + release emitted, prefix match, HTML still fails immediately). Touch `scripts/stamp-release.sh`, `deploy/deploy.sh`, `deploy/verify.sh`, `deploy/deploy.test.mjs`. Size S. Risk low (verify gate must stay green either way).

## 5. What NOT to change

- The agent never vets, by documented design. `worker/src/index.js:4-5`: `The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed).` `README.md:72`: `researching → testing is a human decision … The agent never moves status.` Do not add auto-vet, auto-kill, or auto-testing without an owner-written rule, reversibility, and a real-path test.
- The self-migration stays default-off, ADD-only, triggerless. `functions/api/[[path]].js:16-25` (switch docblock), `:53` (unset → report + change nothing), `:59-67` (one ADD at a time, duplicate-column tolerated, anything else stays missing), once per isolate (`:35,69-71`). Do not default it on, do not add a second trigger, and do not add a migration endpoint: `a URL that alters the schema is a liability even when it is authenticated.`
- Never a data-losing migration here: ADD only — `No DROP, no ALTER of an existing column, no data rewrite, no DELETE.`
- Cloudflare repo secrets are the owner's. The workflow fails fast with a named message until they exist (`.github/workflows/deploy-worker.yml:20-26`). His one line: Settings → Secrets → Actions → add `CF_API_TOKEN` and `CF_ACCOUNT_ID`, then redeploy.
- `ALLOW_SCHEMA_MIGRATION=1` is the owner's decision (a live-DB change); unset behaviour is byte-identical to today. His one line: set `ALLOW_SCHEMA_MIGRATION=1` as a Pages env var and reload `/api/health` once — the two money columns appear and the money legs fill on the same call.
- No writes to production D1 from any round: no `wrangler d1 execute … --remote`, no manual migration, no seed. Applying migrations live is the owner's action.
- Verdicts need a login, a credential, and a human: `ADMIN_TOKEN` (Pages env + worker secret + dashboard `localStorage`) plus per-row judgment from the decision + brief lines. Never mark an experiment won/lost without `result` + `post_mortem` evidence, and never invent a revenue figure — the inline Win close takes a human-entered amount for exactly this reason.
- Never, whatever the ranking says: no spending, no account or identity creation, no outward sends, no accepting terms, no captcha solving, no fabricated reviews/receipts/testimonials, no scraping or messaging a platform's terms forbid, no financial advice or implied return.
- House rules honored by this audit: never read `.env`/secrets/tokens; no edits to existing files (this findings file only); CRLF care (whole-line matches, re-read after edit — unneeded here since nothing was edited).

## 6. Proposed next tasks (2–4)

### Task 1. Review triage mode: V/K keys + auto-advance clears 11 rows in under 2 minutes

Owns: `public/app.js`, `public/dashboard.test.mjs`. Context (F1): the only path from unreviewed to vetted is the manual Vet button (`public/app.js:429` via `vettedNotes` `:409` → `PATCH /api/opportunities/:id`); the worker never vets by design. Add `V` (vet focused review row, auto-focus next unreviewed) and `K` (open the inline post-mortem, Confirm kills and advances, Cancel/Esc keeps the row), reusing `fetchDetailForWrite`, existing toasts, and `refreshReview`; buttons and drawer paths untouched; no bulk or automatic path.

Acceptance: keyboard V/K work on the review list with the admin token set and prompt for the token without it; each verdict PATCHes exactly its row and focuses the next unreviewed (or the empty-queue line after the last); `dashboard.test.mjs` asserts handlers, auto-advance, token gating, and the absence of any auto-vet call; `npm test` green (345+).

### Task 2. Vet-or-kill all 11 unreviewed via dashboard; leave review queue empty

Owns: live dashboard + D1 via the API (no repo files changed). Non-code queue clearing (F1): a human opens the Needs-review filter oldest-first and records Vet (or Vet-&-starter) vs Kill per row from the inline decision + brief lines — no drawer round-trip needed, a couple of minutes with Task 1, longer without.

Acceptance: `/api/health` reads `unreviewed` 0, `oldest_unreviewed_age_h` null, `vetted_last_7d` + kills in the window = 11, `last_vetted` = today; every Vet carries a `[YYYY-MM-DD vetted]` tag, every Kill a one-line post-mortem in notes; next cron resumes inflow (unreviewed ≤ 10 → cap 2/tick). Requires `ADMIN_TOKEN` and human judgment per row; never mark decided without evidence.

### Task 3. Skip classify AI call when inflow paused (unreviewed > 10)

Owns: `worker/src/index.js`, `worker/src/index.test.js`. Waste cut (F3): when `maxNewThisRun == 0`, skip the classify `aiComplete` call, leave `fresh` unprocessed, log `inflow:paused` on the finish line, and still run both brief passes.

Acceptance: a test driving the real `runResearch` against a stubbed D1 with 11 unreviewed rows makes 0 classify AI calls, logs `inflow:paused`, writes ≥1 brief, and leaves new-verdict signals `processed = 0`; with ≤ 10 unreviewed the classify path runs as today (cap 2, bare > 10 → 1); `npm test` green.

### Task 4. Mirror review backlog count into masthead agent pill

Owns: `public/app.js`, `public/index.html`, `public/dashboard.test.mjs`. First-five-seconds fix (F5): pill text/title shows `N to review · oldest Xd` from the health snapshot (cached paint at boot, live refresh wins, failed refresh keeps cache); clicking jumps to the review filter; dot colors and probe-failure tooltip unchanged.

Acceptance: with stubbed health `{unreviewed: 11, oldest_unreviewed_age_h: 175.5}` the pill reads `11 to review · oldest 7d` before the live refresh lands and updates after; the jump sets the review filter; `dashboard.test.mjs` covers pill text, jump, and cache-then-live order; `npm test` green.
