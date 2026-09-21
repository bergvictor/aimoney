# AUDIT-2026-09-20-round3 — aimoney (read-only)

Clone rev `ac8e652` (round 2 head). Live snapshot: `_night/live/` fetched 2026-09-21 (~01:59Z, rev `e28a4e4`).
Only file created by this audit: this one. No existing file was edited.

## 1. What this project is and how it runs

1. Purpose: AIMoney Lab — a ranked list of AI-money opportunities with research briefs, tracked experiments, and an autonomous research agent that proposes new rows.
2. Entry points: dashboard `public/index.html` + `public/app.js`; API `functions/api/[[path]].js` (`onRequest` router); agent `worker/src/index.js` (`scheduled`/`fetch`).
3. Live surfaces: `https://aimoney.pages.dev`, `/api/health`, `/api/opportunities`, `/api/runs`, worker `GET /` (`deploy/public-surfaces.json:31-44`).
4. Scheduled jobs: research worker cron `0 */6 * * *` (`worker/wrangler.toml:9`) — collect signals, AI-triage, brief bare rows; manual triage-only `POST /run` (briefs on cron).
5. Deploys: Pages is git-connected (`scripts/stamp-release.sh` stamps `public/release.json`); `./deploy/deploy.sh` applies D1 schema + `d1/migrate-*.sql` + seed-once, then Pages + worker; CI (`.github/workflows/deploy-worker.yml`) deploys only the worker and applies only `d1/schema.sql`.

## 2. End-to-end walk-through

Main flow: public signal → agent proposal → human vet → experiment → decision with money attached.

1. Cron fires `worker/src/index.js:526-527` → `runResearch(env, "cron")` (`:195`). Runs stuck in `running` >30m are reaped as dead (`:199-204`).
2. Collect: `hnSignals`/`redditSignals`/`githubSignals` (`:47`/`:76`/`:104`) run via `Promise.allSettled` (`:230`); rows batch-inserted into `signals` (`:242-245`); signals >30d old are swept to noise (`:255-256`).
3. Take oldest 6 unprocessed (`:261-263`); exact-URL matches link as `supports` with no AI call and no status move (`:269-295`).
4. One classify call against the top-60 list (`:306-324`); verdicts `new` (capped at 2/run, `:16`) enter as `researching` + `UNREVIEWED` marker + reversible estimates; `supports` appends evidence newest-kept; rest is noise.
5. Brief pass: 1 bare row per cron tick (`:410-469`), +1 extra oldest-unreviewed row when the backlog is >48h old (`:471-474`); empty briefs are never stored (`:457`).
6. Dashboard `public/app.js`: `renderLedger` (`:130`), "Start here today" strip for the #1 actionable pick (`:103-127`), review queue with capital/next-action/source inline (no drawer needed).
7. Human vets (`vetOpportunity`, `app.js:398-411`) or kills with a one-line post-mortem (`:479-491`) → `PATCH /api/opportunities/:id` (`functions/api/[[path]].js:138-179`); "Vet & log starter" also `POST /api/experiments` (`:255`) and flips the row to `testing`.
8. Board one-click Start/Win/Lose (`app.js:677-678`) → `PATCH /api/experiments/:id` (`[[path]].js:~300-358`): closing as won/lost requires `result` + `post_mortem`, stamps `ended_at`/`started_at`, appends a one-line `$X rev / $Y spent` outcome to the parent notes (`:340-347`), stores `revenue_cents`/`spent_cents`/`revenue_source`.
9. `/api/health` (`:374-479`) aggregates ten probes in one `env.DB.batch` with per-probe fallback (`:402-429`); the dashboard renders the experiments header (`app.js:640-666`), agent pill (`:693-726`), and probe-failure banner (`:1155-1167`).

Where it most often breaks or goes silent:

- Live D1 is missing the 2026-09-20 migration columns, so the two revenue probes fail on every health call — now named (`health_probe_failures`), previously a blanket `db down`.
- CI can never heal schema drift: it applies only `d1/schema.sql` (all `CREATE TABLE IF NOT EXISTS`) and, per the orchestrator's trace, has no credentials — so a schema change can never reach the live database from CI.
- Manual `POST /run` shares the 30s `waitUntil` cap (`index.js:225-228`); a killed pass is reaped next run, but its briefs never land on the manual path by design.
- The human queue is the true stall: 11 unreviewed, oldest 169.6h (~7d), `vetted_last_7d` 0, zero running/won/lost experiments live. Every automated hop works; the decisions don't happen.

## 3. Health signals measured here

- Test suite: `npm test` (`node --test` over `worker/src/lib.test.js`, `worker/src/index.test.js`, `functions/api/api.test.mjs`, `public/tab-icon.test.mjs`, `public/dashboard.test.mjs`) — exit 0, all green. A second run with `--test-reporter=dot` showed 342 passing dots, 0 failures, exit 0.
- `compileall`: N/A (JS repo, no Python sources). All shipped modules are parsed by the test run itself; the only diagnostic is a cosmetic `MODULE_TYPELESS_PACKAGE_JSON` warning suggesting `"type": "module"` in `package.json`.
- TODO density: zero matches for `TODO|FIXME|HACK|XXX|console.log|debugger` across the repo.
- Dead code: `worker/src/index.js:296-299` is an empty `if (!fresh.length) {}` block (comment-only); `:322` re-guards `!fresh.length ? [] :` inside a block already guarded by `if (fresh.length)`.
- Duplicated logic: `clamp10` exists in both `functions/api/[[path]].js:16-20` and `worker/src/lib.js:4-7`, although the API already imports `effectiveScore`/`tokensMatch` from the shared lib (`[[path]].js:10`). `centsDollars` (`:24`) mirrors `moneyCents` (`public/app.js:53`) by documented intent.
- Surface rules (all pass): icon link + `theme-color` (`public/index.html:9-10`), hand-written `favicon.svg` (285 bytes, 32×32, `$` glyph on `#0d6b3f`), inline brand mark reusing the same geometry/accent/glyph (`index.html:16`), `color-scheme: light` (`public/styles.css:4`), no `prefers-color-scheme`/`data-theme`/theme-toggle string anywhere in `public/`, guard test `public/tab-icon.test.mjs:48-113` (5 tests). The saved live HTML matches: icon, theme-color, brand mark present; light palette; responsive `@media (max-width: 760px)` (`styles.css:210-215`) with `overflow-x: auto` table wrap (`:105`).
- Live snapshot (`_night/live/`, rev `e28a4e4`): health is `ok:true, db:up`, 27 opportunities, 11 unreviewed, 19 bare, `experiments_by_status: {planned: 2}`, `hours_since_last_ok_run: 2`, `oldest_unreviewed_age_h: 169.6`, `decisions_last_7d/revenue_last_7d/revenue_total/spent_total` all null with `health_probe_failures: ["decisions_revenue_week", "revenue_lifetime"]`, `vetted_last_7d: 0`. Page is HTTP 200, 5514 bytes.
- The delegated health fix is already IN this clone: batch + per-probe fallback (`[[path]].js:402-429`), `db` by whether the database answered (`:479`), failing probes named, regression tests (`functions/api/api.test.mjs:1246-1319`, 3 tests), dashboard pill-tooltip + banner surfacing (`public/app.js:706-707`, `:1155-1167`). Live rev `e28a4e4` proves it works (`db:up` + two named failures instead of blanket `down`).
- `git status --short` showed pre-existing modifications across the tracked tree before this audit began (untouched by me; read-only lane). The only file I created is this audit.

## 4. Ranked findings (max 8)

Money-first answers (numbers from the project's own live health, 2026-09-21T01:59Z):

- Earned to date: none recorded — live has zero won/lost experiments (only 2 `planned`) and `revenue_total` is null (probe failing, truth unknown). The last krone arrived: never.
- aimoney is a tool the owner uses to pick money-making experiments, not a product he sells. Ranked below by owner-time saved and experiments decided, not by revenue.
- Single step between the current state and the next payment: start and close one zero-spend experiment — the seeded "Spec-ad sprint: 10 brands, 10 free ads" (`d1/seed.sql:67-71`) names the candidate — and record its `revenue_cents`.
- Measured conversion at that step: 0 experiment decisions/week (`decisions_last_7d` null, no won/lost rows) and 0 vetted/week (`vetted_last_7d` 0) across consecutive snapshots. The bottleneck is outside the code: the owner pressing Vet/Start on an 11-deep queue whose oldest row is ~7 days old.

Lane metric: experiments reaching a decision (won/lost with post-mortem) per week — currently 0; unreviewed backlog — 11 and aging.

### F1. CI can never apply a migration, so the live DB is missing 3 columns (the 2 named failing probes)

Evidence: `.github/workflows/deploy-worker.yml:20` runs only `wrangler d1 execute aimoney --file=d1/schema.sql --remote` (all `CREATE TABLE IF NOT EXISTS`, cannot add columns); `d1/migrate-2026-09-20-experiment-cents.sql:5-6` and `d1/migrate-2026-09-20-revenue-source.sql:5` add `revenue_cents`/`spent_cents`/`revenue_source`, applied only by `deploy/deploy.sh:34-38`; live health names `decisions_revenue_week` + `revenue_lifetime` as failing. Per the orchestrator's trace the workflow's `CF_API_TOKEN`/`CF_ACCOUNT_ID` secrets resolve empty, so wrangler cannot even authenticate.

Why it costs: `decisions_last_7d`, `revenue_last_7d`, `revenue_total`, `spent_total` are permanently null on live, and every future migration is stranded the same way. Nothing in the database path can work until the secrets exist.

Fix: in `.github/workflows/deploy-worker.yml`, after the schema step, loop over `d1/migrate-*.sql` exactly like `deploy/deploy.sh:34-38` (tolerating the duplicate-column error on re-runs), and add a guard step that fails loudly when the secrets are empty instead of letting wrangler fall back to interactive login. Owner action (never an agent's): add `CF_API_TOKEN` and `CF_ACCOUNT_ID` to this repository's secrets. Size M. Risk: low — additive columns with defaults, re-run safe via the tolerated error.

### F2. Practical brief throughput trails proposal inflow — 19 of 27 rows have no brief

Evidence: inflow cap `MAX_NEW_PER_RUN = 2` (`worker/src/index.js:16`) on every run including manual triage-only runs (which brief nothing, `:590`), vs at most 1+1 briefs per cron tick (`:410-474`) with the extra brief gated on `bare && ai_calls < MAX_AI_CALLS && clock` (`:474`); live `bare_without_brief: 19`.

Why it costs: a decision needs the brief's next-action line in front of the owner (`public/app.js:108-117`); bare rows force drawer-diving and slow the <1-minute phone review that would drain the 11-deep queue.

Fix: when the backlog is >48h old, brief the extra oldest-unreviewed row first, ungated from the first pass's `bare` result, still within `MAX_AI_CALLS` — a worker-side, reversible throughput change. Files: `worker/src/index.js`, `worker/src/index.test.js`. Size S. Risk: low (one extra AI call per tick, bounded).

### F3. First paint shows placeholders, not truth (the five-second gap)

Evidence: `public/index.html:23` renders `agent: …`, `:52` renders `Needs review (…`, `:73` renders `Loading priority list…`; the "Start here today" strip only paints after the opportunities fetch (`public/app.js:103-127`). On a slow phone connection the owner's first five seconds are placeholders.

Why it costs: this is a daily-driver surface; a blank first paint on every open erodes the habit that drains the queue.

Fix: persist the last-good health + top-pick snapshot to `localStorage` on each successful refresh, and paint the pill/strip/review chip from cache synchronously on load before the live refresh (with a stale mark if older than one cron tick). Files: `public/app.js`, `public/dashboard.test.mjs`. Size M. Risk: low (read-only cache, live data always wins).

### F4. A spuriously-rejected batch yields an empty `health_probe_failures: []` key

Evidence: `functions/api/[[path]].js:425-428` assigns `healthProbeFailures = failed` even when `failed` is empty, and `:479` spreads the key whenever the array is truthy (an empty array is truthy). `probeFailures()` (`public/app.js:1155-1158`) tolerates it via a length check, so no UI break — contract noise with no covering test.

Why it costs: trust in the new field; consumers cannot distinguish "probed, all fine" from "fallback ran".

Fix: set `healthProbeFailures` only when `failed.length > 0` (else `null`), and add a regression test where the batch rejects but all ten individuals answer. Files: `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Size S. Risk: negligible.

### F5. Duplicated `clamp10` between the API and the shared lib

Evidence: `functions/api/[[path]].js:16-20` keeps a local `clamp10` while importing `effectiveScore`/`tokensMatch` from `worker/src/lib.js` (`:10`), which exports its own `clamp10` (`lib.js:4-7`).

Why it costs: silent drift risk — input bounds are a trust boundary for scores, and two copies can diverge without failing any test.

Fix: import `clamp10` from `../../worker/src/lib.js` and delete the local copy. Files: `functions/api/[[path]].js`. Size S. Risk: negligible (behavior is identical today; bounds tests cover both ends).

### F6. No-op PATCH still rewrites the row and bumps `updated_at`

Evidence: `updateOpportunity` (`functions/api/[[path]].js:141-178`) always executes the `UPDATE` (`:168-177`) including `updated_at=strftime(...)`, even when no field changed.

Why it costs: a drawer save with no edits reorders `sort=updated` and fakes freshness, adding noise to the exact list the owner triages.

Fix: compare the clamped `next` against `cur` and return the current score early when nothing changed. Files: `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Size S. Risk: low.

Surface-rule findings: none — icon, brand mark, light-only palette, and guard test all pass (see §3).

## 5. What NOT to change

- The agent proposes; the human owns status: "The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed)" (`worker/src/index.js:4-5`; README: "The agent never moves status"). No auto-transitions, no auto-vetting.
- Scores and rescoring are never automatic: the drawer rescore suggestion is one the "human applies with one click — never auto-applied" (README), and unreviewed rows stay capped at 6000 (`worker/src/lib.js:22`).
- The closure gate (won/lost requires `result` + `post_mortem`) and the one-line outcome ledger append are deliberate honesty machinery; do not loosen them.
- `deploy/deploy.sh:39-47` seeds only when the opportunities table is empty — never reseed over live agent/human rows.
- Credentials and human decisions: never create, enter, or store `CF_API_TOKEN`, `CF_ACCOUNT_ID`, or `ADMIN_TOKEN` (owner adds the repo secrets); never press Vet/Kill/Start/Win/Lose or mark an experiment decided — the one-click buttons exist for the owner, including the seeded zero-spend "Spec-ad sprint".
- Unverified externals: HN/Reddit/GitHub source health cannot be diagnosed from this offline clone — do not "fix" collectors blind; the `src_fail:*` run-log markers (`worker/src/index.js:517`) already name outages.

## 6. Proposed next tasks (2–4)

1. `CI applies d1/migrate-*.sql after schema.sql and fails loudly without credentials` — owned files: `.github/workflows/deploy-worker.yml` (mirror `deploy/deploy.sh:34-38`; guard on empty secrets). Acceptance: workflow contains the migrate loop + empty-secret guard; takes effect once the owner adds the two repo secrets; live `health_probe_failures` clears on the next worker push.
2. `Dashboard paints pill/strip from last-good cache before first fetch` — owned files: `public/app.js`, `public/dashboard.test.mjs`. Acceptance: with fetch blocked, pill/strip/review chip show cached values; with live fetch, fresh values win; `npm test` green.
3. `Brief throughput: extra oldest-unreviewed brief ungated from first pass` — owned files: `worker/src/index.js`, `worker/src/index.test.js`. Acceptance: backlog >48h with an empty first pass still briefs the oldest bare row; `MAX_AI_CALLS` respected; `npm test` green.
4. `Attach health_probe_failures only when non-empty, plus regression test` — owned files: `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Acceptance: batch-rejects-but-all-answer yields no new key; the three existing isolation tests stay green.
