# Audit 2026-09-20 round 1 — aimoney (read-only)

Clone: the brief names `/mnt/c/coding-projects/_workspace/trackb-aimoney-r1`; as mounted
here the same checkout is `/root/coding-projects/_workspace/trackb-aimoney-r1` (the
runner's `_night/tests-baseline.log` references its Windows twin
`C:\coding-projects\_workspace\trackb-aimoney-r1`). HEAD `170d772` = shipped night
round 4. No existing file edited, no network, no installs, never read `.env`/secrets.
Only this file created. `git status --short` was empty before it.

## 1. What this project is and how it runs

- Purpose: AIMoney Lab — ranked AI-money opportunities with research briefs and experiments; the agent proposes, a human vets and tests.
- Entry points: `public/index.html` + `public/app.js` (dashboard), `functions/api/[[path]].js` (D1-backed REST API), `worker/src/index.js` (research agent).
- Live surfaces: `https://aimoney.pages.dev/` (dashboard), `/api/health`, `/api/opportunities`, `/api/runs`, worker `https://aimoney-research.levitinvlad.workers.dev/`.
- Scheduled jobs: worker cron `0 */6 * * *` (every 6h: collect + triage + briefs) and manual `POST /run` (202, triage-only, `briefs_skipped:true`).
- Deploys: Pages Git-connected (`public/` + `scripts/stamp-release.sh`) plus CI `.github/workflows/deploy-worker.yml` (schema + shared migrations + worker) or manual `deploy/deploy.sh`, gated by `deploy/verify.sh`.

## 2. End-to-end walk-through

Signal to decision; the hop where it most often goes silent is at the end.

1. Collect: `worker/src/index.js:49` `hnSignals`, `:78` `redditSignals`, `:106` `githubSignals` via `timedJson` (`:37`, 6s timeout covering the body read). Per-query throw marks the source; all-failed names it in `src_fail`.
2. Store: `:354-359` one batched `INSERT OR IGNORE INTO signals`, then heartbeat `:360-363` (`phase:collected`).
3. Sweep: `:367-372` unprocessed signals older than 30d become noise (`stale:N`).
4. Take: `:374-376` oldest-first `LIMIT 6` (`MAX_AI_SIGNALS`).
5. Exact-URL pre-pass (no AI): `:382-408` via pure `exactUrlTarget` (`:168`); exact matches link as supports, notes newest-kept, no status move.
6. Gates (read once, before classify): `:420-428` bare-without-brief > 10 caps inserts to 1/tick; unreviewed > 10 pauses inflow to 0/tick. Live unreviewed is 11, so the pause is engaged.
7. Classify (one AI pass): `:438-452` — skipped entirely when paused (`inflow:paused`) or when `fresh` is empty; otherwise `buildClassifyPrompt` (`:272`) + `aiComplete` (`:136`) parsed by `parseJsonLines` (`worker/src/lib.js:62`, NDJSON + `repairJson`).
8. Verdicts: `:464-532`; new rows `INSERT` (`:491-506`) carrying `UNREVIEWED` (`:502`) with capped `effectiveScore`; slug collision links as supports (`:507-519`); writes flush via `flushVerdictWrites` (`:291`, batch with per-write fallback, failures as `verdict:N_failed`).
9. Briefs: main `:545-581` (top-scored, or oldest-unreviewed-first past 48h — live age 177h, so oldest-first) plus extra `:588-623` when oldest unreviewed exceeds 48h, via `buildBriefPrompt` (`:202`), `parseBriefJson` (`:213`), `insertBrief` (`:224`, never stores empty), poison rotation `:248-265`.
10. Finish: `:626` single `finish("ok", …)` carrying `brief:mode`, `inflow:paused`, `stale:N`, `src_fail`, `brief:failed`, `verdict:N_failed`; errors `:628-636` finish `error` plus `console.error("cron-failed", …)` tail marker (`:634`; also `:646` scheduled, `:710` manual).
11. Worker routes: `GET /` (`:651-663`, 503 + `ok:false` when D1 dead), `GET /ping-ai` (`:665`), `GET /debug-classify` (`:680`), `POST /run` (`:702-713`, token-gated 202 with `briefs_skipped:true`).
12. Dashboard review: `public/app.js:189` `renderReview` with decision line (`:167` capital + next + source) and brief line (`:181` summary or `No brief yet`) plus Vet / Vet-&-starter / Kill buttons (`:199-203`); client-side oldest-first queue (`:239-263`); `V`/`K` triage keys with auto-advance (`:540-600`); Start-here strip (`:103`) with Vet/Kill for unreviewed top picks (`:124-131`); pill backlog mirror (`:294-301`, paint `:817-820`); last-good cache first paint (`:1338-1430`, boot `:1503`).
13. THE VET PATH (this round's Q1 — one sentence): a human presses Vet in the dashboard (`public/app.js:443` `vetOpportunity` → `:433` `fetchDetailForWrite` → `:448` inner → `:423` `vettedNotes`, which clears `UNREVIEWED` and appends `[YYYY-MM-DD vetted]`) and the write lands via `PATCH /api/opportunities/:id`; starter variant `:473-507` adds a planned experiment and flips the row to `testing` in one tap.
14. API writes: `functions/api/[[path]].js:209` `updateOpportunity` (text bounds, status/range guards, `effectiveScore`), `:326` `createExperiment` / `:390` `updateExperiment` (won/lost require `result` + `post_mortem`, `started_at`/`ended_at` stamps, outcome ledger `:427-436`, cents clamps, `revenue_source` retry tolerance `:367-376`, `:448-457`).
15. Health: `:474-635` 12-probe batch (`:490-507`) with per-probe isolation fallback (`:517-546`, failures named in `health_probe_failures` + column-only `health_probe_detail`), lazy self-migration (`:554-571` via `ensureMoneyColumns` `:34-72`), `last_vetted` JS parse (`:596-604`), payload `:635` (`ok:false` + nulls only on total outage).
16. Deploy chain: `deploy/deploy.sh:33,37` schema + shared `deploy/apply-d1-migrations.sh` (sorted glob, duplicate-column tolerated, anything else exits 1) + fail-closed seed guard (`:38-55`); CI `.github/workflows/deploy-worker.yml:20-37` fails fast on empty secrets, then schema + the same shared script + worker deploy; `deploy/verify.sh` markers + app.js parse gate (`:36-52`) + live-revision gate (`:66-100`, short-SHA `release.json`, stale retried 6×10s, HTML/unparsable/placeholder fail immediately) + nonempty list (`:102-108`) + agent freshness (`:110-118`). No `/build.json`: `release.json` is the one checked source of truth, and `/api/health` rev comes from it via `cachedHealthRev` (`[[path]].js:627-634`).

Where it most often breaks or goes silent: hop 13, the human Vet press. Nothing automated was ever supposed to vet (see F1): cron ticks succeed (`hours_since_last_ok_run` 3.6) while `vetted_last_7d` stays 0 and the oldest unreviewed ages (177.3h and rising 1d/d). Second: the money probes (hop 15) return null because the money columns never reached live D1 and the self-migration is disabled (see F2) — owner-gated, not code-broken.

## 3. Health signals measured here

- Test suite: `npm test` (`node --test` over `worker/src/lib.test.js`, `worker/src/index.test.js`, `functions/api/api.test.mjs`, `d1/migrations.test.mjs`, `deploy/deploy.test.mjs`, `public/tab-icon.test.mjs`, `public/dashboard.test.mjs`) → `tests 360, suites 120, pass 360, fail 0, cancelled 0, skipped 0`, `duration_ms 90545.08`, exit 0, `node v22.22.3`. Real run in this session, no narrowing (live window truncated the 102KB TAP; the counts above are the run's own summary tail read back afterwards). Matches the runner's Windows baseline (`_night/tests-baseline.log`: 360/360, `duration_ms 90293.81`).
- Parse: the suite's shipped-JS parse gate (`node --check` over every shipped JS file plus a broken-syntax positive control) is green inside the 360; `python3 -m compileall` not applicable — zero `*.py` files in the repo (verified by filename search).
- Dead code: none in shipped source. Scoring/auth/brief/classify/insert prompts all shared (`effectiveScore` + `tokensMatch` in `worker/src/lib.js`, imported by the API at `functions/api/[[path]].js:10`); `console.*` is only the three deliberate `console.error("cron-failed", …)` markers (`worker/src/index.js:634,646,710`); no `debugger`, no `log/debug/warn`.
- Duplicated logic: none material. `centsDollars` (`[[path]].js:82`) mirrors `money()` in `public/app.js` by documented contract with tests both sides. One negligible nit, not a finding: `deriveReviewList` (`public/app.js:240`) inlines the `isNeedsReview` predicate (`:234-237`) instead of calling it.
- TODO density: zero in shipped source. Regex `TODO|FIXME|HACK|XXX|console\.|debugger` over `functions worker/src public/app.js d1 deploy scripts` hits only the three `cron-failed` markers plus their test-harness captures (`worker/src/index.test.js:626-631,796-806`). Positive controls: the same tool and mode matches `TODO|FIXME` in `docs/audits/*.md` prose and `UNREVIEWED` 10× in `worker/src/index.js`, so both the zero and the search are real.
- Surface rules: light-only (`public/styles.css:4` `color-scheme: light`; no `prefers-color-scheme`/`data-theme`/toggle in `public/` — the guard tests assert the absence while asserting the presence of `color-scheme: light`, `public/tab-icon.test.mjs:66-76`); favicon linked (`public/index.html:9-10`, `public/favicon.svg` one line, 32×32 `$` on `#0d6b3f`, well under 2 KB); brand mark inline in header (`public/index.html:16`, same geometry/accent/glyph); guard suite green inside the 360.
- Working tree: `git status --short` empty before this file; `git ls-files --eol` shows all 37 tracked files `i/lf w/lf` under `* text=auto eol=lf` (`.gitattributes:4`) — no CRLF dirt.
- Live snapshot `_night/live/aimoney_pages_dev_api_health.html:1` (rev `170d772` == HEAD, so the edge serves the latest commit and the `stamp-release.sh` wiring works end to end): `ok:true, db:up, opportunities:27, unreviewed:11, bare_without_brief:19, experiments_by_status:{planned:2}, hours_since_last_ok_run:3.6, oldest_unreviewed_age_h:177.3, decisions_last_7d:0, revenue_last_7d:null, revenue_total:null, spent_total:null, vetted_last_7d:0, last_vetted:null, vetted_no_experiment:0, noise_24h:0, health_probe_failures:[revenue_week,revenue_lifetime], health_probe_detail:{…:revenue_cents}, schema_missing_columns:[revenue_cents,spent_cents], schema_migration:disabled…`. Dashboard shell `_night/live/aimoney_pages_dev.html` (121 lines) matches `public/index.html` line for line: light, favicon, brand, agent pill, tabs, review chip, neutral `…` placeholders.

## 4. Ranked findings (max 8)

Lane metric (aimoney): experiments reaching a decision (won/lost + post-mortem) per week, and vetted proposals becoming experiments; unreviewed backlog drained. Current: `decisions_last_7d` 0, `vetted_last_7d` 0, `vetted_no_experiment` 0, unreviewed 11 (oldest 177.3h / 7.4d, rising 1d/d — the same 11 rows prior audits saw at 174.6h and 175.5h), bare-without-brief 19/27, experiments `{planned: 2}`, `last_vetted` null, `hours_since_last_ok_run` 3.6.

Money-first (owner directive), in this project's own numbers. This project is a tool the owner uses to rank and test AI-money ideas, not a product he sells; rank by owner time saved and decisions/week, measured the same way. Earned to date: none measured — `revenue_total` null, `revenue_last_7d` null, `spent_total` null (unknown, not zero; the live D1 lacks the money columns so the probes cannot run). No experiment closed won/lost in 7d (`decisions_last_7d` 0); no row ever vetted (`last_vetted` null). Last krone arrived: never recorded. Single step between now and the next payment: vet the 11 rows, start one $0-capital starter, run it 7 days to won/lost with a human-entered amount + source + post-mortem via the inline close. Measured conversion at that step: 0/11 vetted (0%), 0/2 planned started (0%), 0 decisions/week. Honesty: no projection presented as result, no rate × volume multiplication, no attempt counted as outcome (signals seen ≠ proposals, proposals ≠ vetted, planned ≠ running). The number did not move this round: unreviewed was 11, is 11. The single owner action that moves it: open Needs review and press V or K eleven times.

### F1. Nothing automated was ever supposed to vet — the 11-row queue waits on a human press

Evidence. `worker/src/index.js:4-5`: `The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed).` Every worker `UNREVIEWED` hit is create (`:499` capped score, `:502` marker text `… UNREVIEWED, scores capped until a human vets it …`), count (`:426-427` pause gate), or select (`:548,556,597,601` brief queries) — no worker statement clears the marker (positive control: the same search returns those 10 sites, so the absence of a clearing path is real). `README.md:71`: `A human admin vets each row`; `README.md:72`: `The agent never moves status.` The moving path is a manual dashboard press: `public/app.js:443` `vetOpportunity` (also V key `:600`, start-here Vet `:130`, starter `:473`) via shared `vettedNotes` (`:423-426`) → `PATCH /api/opportunities/:id`, counted by the `vetted_7d` probe (`functions/api/[[path]].js:503`) and dated by `last_vetted` (`:506,596-604`). Live: `vetted_last_7d` 0, `last_vetted` null, unreviewed 11, oldest 177.3h, while `hours_since_last_ok_run` is 3.6 — something runs (cron triage + briefs) and yields no verdicts by design, not by failure. There is no guard that never passes, no exhausted budget, no empty candidate query, no swallowed exception: there is no automated vet path to fail, so no failing-test cause exists in code.

Why it costs: the lane metric is frozen at every stage (0 vetted/week → 0 started → 0 decisions/week, 2 planned stuck), inflow is paused at 0/tick while unreviewed > 10 (`worker/src/index.js:426-427`, classify skipped `:439-451`), and nine rounds of machinery never moved the queue because the move is human-gated and the human has not pressed.

Fix: no code change — the smallest clearing tool already shipped (V/K + auto-advance, per-row Vet/Starter/Kill with inline decision + brief lines, pill backlog mirror). The fix is the verdict session itself: Task 1. Touch no repo files. Size S. Risk none (reversible token-gated PATCHes, human presses every verdict, no status auto-moves).

### F2. Live money legs are null — the columns never reached D1 and the migration is disabled

Evidence. Live snapshot: `"revenue_last_7d":null,"revenue_total":null,"spent_total":null,"health_probe_failures":["revenue_week","revenue_lifetime"],"health_probe_detail":{"revenue_week":"revenue_cents",…},"schema_missing_columns":["revenue_cents","spent_cents"],"schema_migration":"disabled (set ALLOW_SCHEMA_MIGRATION=1 to add missing columns)"`. The two failing probes are the only money readers (`functions/api/[[path]].js:501-502`). `d1/schema.sql:5` is `CREATE TABLE IF NOT EXISTS` (no-op on the existing table); the ADD COLUMNs exist only in `d1/migrate-2026-09-20-experiment-cents.sql:5-6` (+ `revenue_source` in `d1/migrate-2026-09-20-revenue-source.sql:5`), applied by CI `.github/workflows/deploy-worker.yml:27,33-37` and `deploy/deploy.sh:33,37` via `deploy/apply-d1-migrations.sh` — which never ran against live D1 (no `CF_API_TOKEN`/`CF_ACCOUNT_ID` repo secrets; fail-fast `:20-26`). The in-worker fallback is deliberately off: `[[path]].js:53` `if (String(env.ALLOW_SCHEMA_MIGRATION || "") !== "1")` → report missing + disabled, change nothing. All three migration tests pass (`functions/api/api.test.mjs:1617,1644,1663`: migrate-with-var, unchanged-without-var, second-run no-op).

Why it costs: earned-to-date is unknown rather than zero, so the money-first question cannot be answered from the project's own data. The decisions COUNT split (`:500`, no money column) already saved `decisions_last_7d` (= 0, not null) — the money legs are the only remaining nulls.

Fix: no code change; the path is already correct (isolation fallback, column-only detail, ADD-only self-migration, sorted shared migrations, convergence tests with a positive control — all in the 360 green). The owner either sets `ALLOW_SCHEMA_MIGRATION=1` as a Pages env var (next `/api/health` PRAGMAs `experiments`, applies exactly the two ADD COLUMNs one at a time, re-runs the failed money probes on the same call; second run a clean no-op) or adds the two Cloudflare repo secrets and redeploys so CI applies the migrations. One variable, one decision — see §5. Touch no repo files. Size S. Risk none (ADD COLUMN with DEFAULT cannot lose a row; unset behaviour is byte-identical to today).

### F3. `last_vetted` probe fetches the full notes of every vetted row on each health call

Evidence. `functions/api/[[path]].js:506`: `SELECT notes FROM opportunities WHERE notes LIKE '%vetted]%'`; `:596-604`: JS `matchAll(/\[(\d{4}-\d{2}-\d{2}) vetted\]/g)` max over all returned rows. Notes bodies run to 8000 chars (`public/app.js:425` `slice(-8000)`); every dashboard load and every `verify.sh` poll pays the scan. At 0 vetted rows (live) this is cheap; at hundreds of vetted rows it becomes megabytes per `/api/health` — the dashboard's hottest read.

Why it costs: D1 egress and latency that grow with success (more vettes = slower health); the stall-age signal this probe exists to provide gets more expensive exactly as the queue starts moving. Small today, structural tomorrow.

Fix: select a bounded tail (`substr(notes, -500)`) since `vettedNotes` appends newest-last under the same 8000-char cap, keeping the JS regex max so every tag in the row still counts; or add an indexed `last_vetted` column updated on vet PATCH (migration + tag backfill). Pin in `functions/api/api.test.mjs`: a long-notes row still reports its newest tag while the probe transfers the bounded shape. Touch `functions/api/[[path]].js`, `functions/api/api.test.mjs` (plus one `d1/migrate-*` file if the column route is chosen). Size S (tail) / M (column). Risk low (read-only probe, null fallback preserved).

### F4. Release marker uses a short SHA and omits the package version

Evidence. `scripts/stamp-release.sh:6` and `deploy/deploy.sh:58`: `REV` cut to 7 chars; `public/release.json` carries `{project, revision, built_at}` with no `release`, while `package.json:2` versions the repo at `0.1.0` unstamped. `deploy/verify.sh:66-100` compares short == short, retries stale 6×10s, and fails HTML/unparsable/placeholder bodies immediately — the check is sound, the identifier is short. Single source of truth is preserved (`/api/health` rev comes from `release.json`, `[[path]].js:627-634`; live `rev` `170d772` == HEAD proves the stamp path works). The committed `dev-undeployed` placeholder can never ship silently (verify fails it at `:88-90`).

Why it costs: 7 hex chars are fine under ~10k commits but ambiguous across forks and long history; version drift between the repo tag and the live surface is invisible. Low impact today, exactly the kind of staleness the live-revision gate exists to catch.

Fix: stamp the full 40-char SHA as `revision` plus the package version as `release` (keep the short form in the deploy log), with verify accepting full or short-prefix; or document short-SHA as deliberate for this single-repo scale in `deploy/public-surfaces.json`. Do not add `/build.json` — `release.json` is the one checked source. Pin in `deploy/deploy.test.mjs` (full SHA + release emitted, prefix match, HTML still fails immediately). Touch `scripts/stamp-release.sh`, `deploy/deploy.sh`, `deploy/verify.sh`, `deploy/deploy.test.mjs`. Size S. Risk low (verify gate must stay green either way).

## 5. What NOT to change

- The agent never vets, by documented design. `worker/src/index.js:4-5`: `The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed).` `README.md:72`: `researching → testing is a human decision … The agent never moves status.` Do not add auto-vet, auto-kill, or auto-testing without an owner-written rule, reversibility, and a real-path test.
- The self-migration stays default-off, ADD-only, triggerless. `functions/api/[[path]].js:16-25` (switch docblock), `:53` (unset → report + change nothing), `:59-67` (one ADD at a time, duplicate-column tolerated, anything else stays missing), once per isolate (`:35,69-71`). Do not default it on, do not add a second trigger, and do not add a migration endpoint: `a URL that alters the schema is a liability even when it is authenticated.`
- Never a data-losing migration here: ADD only — `No DROP, no ALTER of an existing column, no data rewrite, no DELETE.`
- Cloudflare repo secrets are the owner's. The workflow fails fast with a named message until they exist (`.github/workflows/deploy-worker.yml:20-26`). His one line: Settings → Secrets → Actions → add `CF_API_TOKEN` and `CF_ACCOUNT_ID`, then redeploy.
- `ALLOW_SCHEMA_MIGRATION=1` is the owner's decision (a live-DB change); unset behaviour is byte-identical to today. His one line: set `ALLOW_SCHEMA_MIGRATION=1` as a Pages env var and reload `/api/health` once — the two money columns appear and the money legs fill on the same call.
- No writes to production D1 from any round: no `wrangler d1 execute … --remote`, no manual migration, no seed. Applying migrations live is the owner's action.
- Verdicts need a login, a credential, and a human: `ADMIN_TOKEN` (Pages env + worker secret + dashboard `localStorage` `aimoney_admin`, `public/app.js:11`) plus per-row judgment from the decision + brief lines. Never mark an experiment won/lost without `result` + `post_mortem` evidence, and never invent a revenue figure — the inline Win close takes a human-entered amount for exactly this reason.
- Never, whatever the ranking says: no spending, no account or identity creation, no outward sends, no accepting terms, no captcha solving, no fabricated reviews/receipts/testimonials, no scraping or messaging a platform's terms forbid, no financial advice or implied return.
- House rules honored by this audit: never read `.env`/secrets/tokens; no edits to existing files (this findings file only); no network (live state read from `_night/live/` only); CRLF care unneeded — tree is LF-pinned and clean.

## 6. Proposed next tasks (2–4)

### Task 1. Vet-or-kill all 11 unreviewed rows via the dashboard review queue

Owns: live dashboard + D1 via the API (no repo files changed). Non-code queue clearing (F1 — the explicit focus instruction's actionable remainder now that the triage tooling has shipped): a human opens the Needs-review filter oldest-first and records Vet (button or `V`) vs Kill (button or `K` + one-line post-mortem) per row from the inline decision + brief lines — no drawer round-trip, a couple of minutes.

Acceptance: `/api/health` reads `unreviewed` 0, `oldest_unreviewed_age_h` null, `vetted_last_7d` + kills in the window = 11, `last_vetted` = today; every Vet carries a `[YYYY-MM-DD vetted]` tag, every Kill a one-line post-mortem in notes; next cron resumes inflow (unreviewed ≤ 10 → cap 2/tick). Requires `ADMIN_TOKEN` and human judgment per row; never mark decided without evidence.

### Task 2. Run one $0-capital starter experiment for 7 days to a won/lost close

Owns: live dashboard + D1 via the API (no repo files changed). Non-code money mover (F1/F2): after Task 1, filter Zero spend, Vet-&-log-starter the top row, Start it, run 7 days against its metric, then close won/lost via the inline Win/Lose with a human-entered amount + source + post-mortem so the closed money is an amount, a date, and a source instead of a status.

Acceptance: `/api/health` shows `decisions_last_7d` ≥ 1 with `ended_at` in-window, the outcome-ledger line on the parent notes carries `$X rev / $Y spent`, and (once F2's owner switch is set) `revenue_last_7d`/`revenue_total` report from `revenue_cents` instead of null. Requires `ADMIN_TOKEN`; never invent the amount.

### Task 3. Bound the last_vetted health probe to a trailing notes slice

Owns: `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Reliability cut (F3): probe 11 selects `substr(notes, -N)` instead of full bodies (tags append newest-last), keeping the JS newest-tag max; null fallback preserved.

Acceptance: a stubbed-D1 row with 8000-char notes still reports its newest `[date vetted]` tag while the probe transfers the bounded shape; `last_vetted` null when no vetted row exists; every other health key byte-identical; `npm test` green (360+).

### Task 4. Stamp full-SHA revision plus package release into release.json

Owns: `scripts/stamp-release.sh`, `deploy/deploy.sh`, `deploy/verify.sh`, `deploy/deploy.test.mjs`. Identity hardening (F4): `revision` becomes the full 40-char SHA with `release` from `package.json`; verify accepts full or short-prefix; short form stays in the deploy log; no second source of truth.

Acceptance: fresh stamp emits full SHA + `release: 0.1.0`; verify passes on full and on short-prefix, still fails HTML/unparsable/placeholder immediately and retries stale bounded; `npm test` green.
