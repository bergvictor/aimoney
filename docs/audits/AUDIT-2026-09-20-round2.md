# AUDIT 2026-09-20 round 2 — aimoney (read-only)

Clone HEAD: `e28a4e4` (night round 1). Live rev at fetch: `284163c`.
Tree note: `git status --short` showed every file `M` on arrival, but `git diff -w --stat` is
empty — a CRLF-checkout artifact, zero content diff. This file is the only content added.

## 1. What this project is and how it runs

AIMoney Lab ranks AI-money opportunities, keeps research briefs, and tracks experiments to a won/lost decision.
Entry points: dashboard `public/index.html` + `public/app.js`, API `functions/api/[[path]].js`, agent `worker/src/index.js`.
Live surfaces: `https://aimoney.pages.dev`, `/api/health`, `/api/opportunities`, worker `GET /` (`deploy/public-surfaces.json`).
Scheduled job: worker cron `0 */6 * * *` (`worker/wrangler.toml:9`) → `scheduled` → `runResearch` (`worker/src/index.js:526,195`).
Deploys: Pages auto-deploys on push to master (build stamps `public/release.json` via `scripts/stamp-release.sh`); worker via `deploy/deploy.sh` or `.github/workflows/deploy-worker.yml`; verified by `deploy/verify.sh`.

## 2. End-to-end walk-through

Main flow A — signal → proposal → brief (agent, no human): cron `worker/wrangler.toml:9` →
`scheduled` (`worker/src/index.js:526`) → `runResearch(env,"cron")` (`worker/src/index.js:195`) →
parallel `hnSignals`/`redditSignals`/`githubSignals` (`worker/src/index.js:47,76,104`, fetch via
`timedJson` `:35`) → dedupe against D1 → Workers AI triage via `aiComplete` (`worker/src/index.js:134`,
prompt `worker/src/index.js:561-570`, NDJSON parse `worker/src/lib.js:62-77`) → ≤2 new
`researching` rows + versioned brief INSERT (`worker/src/index.js:501-508`) → single run-log write
with failure markers (`worker/src/index.js:517`). Manual path: `POST /run` returns 202 with
`briefs_skipped:true` (`worker/src/index.js:582-590`); briefs land on cron ticks only.

Main flow B — proposal → vetted → experiment → decision (human owns every status move):
`GET /api/opportunities?unreviewed=1&sort=oldest` (`functions/api/[[path]].js:44-86`) renders the
review queue and the "Start here today" strip (`public/app.js:103-127`, container `public/index.html:42`) →
owner taps Vet/Kill/`Vet & log starter` in row, strip, or drawer → experiment `planned → running`
(one-click Start) → close `won`/`lost` requires `result` + `post_mortem`, stamps `ended_at`
(`functions/api/[[path]].js:306-359`) → `/api/health` counts `decisions_last_7d`/`revenue_last_7d`
(`functions/api/[[path]].js:396-397`) → Experiments header renders the week (`public/app.js` header).

Where it most often breaks or goes silent. (1) Live D1 never received the 2026-09-20 column
migrations, so the two health SELECTs on `revenue_cents`/`spent_cents` fail; on live rev `284163c`
the all-or-nothing `env.DB.batch(...)` turns that into `db:"down"` with every count null while
`/api/opportunities` serves real rows (see Findings 1–2). (2) The human queue: vetting and every
status move require an owner tap, and the lane metric sits at zero decisions (see Money first).
(3) Agent-side, source/AI failures are contained per-source (`src_fail:`, `brief:failed` markers in
the run log, `worker/src/index.js:517`) — that path degrades loudly, not silently.

## 3. Health signals measured here

- `npm test` (`node --test worker/src/lib.test.js worker/src/index.test.js
  functions/api/api.test.mjs public/tab-icon.test.mjs public/dashboard.test.mjs`): exit 0 —
  `# tests 247, # suites 87, # pass 247, # fail 0, # cancelled 0, # skipped 0, # todo 0,
  # duration_ms 2995.942509` (TAP tail, this run). Includes `health probe isolation`
  (`functions/api/api.test.mjs:1246-1319`, 3 tests) and `health outage honesty` (`:1191-1244`).
- `node --check public/app.js`: exit 0. Python `compileall`: not applicable — no Python
  sources in this repo (JS-only; the suite imports all server sources, so green tests imply parse-clean).
- Dead code: none newly found; the suite's `hygiene: dead rails gone, shared auth` case passes.
  Duplicated logic: `centsDollars` (`functions/api/[[path]].js:24`) mirrors `moneyCents`
  (`public/app.js:53`) — intentional, commented as a mirror; `clamp10` exists in both
  `functions/api/[[path]].js:16` and `worker/src/lib.js:4` with near-identical logic (minor drift risk, unranked).
- TODO density: **0** — regex `TODO|FIXME|HACK|XXX` over the repo hits only the three prior
  audit docs in `docs/audits/`, which record the same zero.
- Live surfaces fetched for this run: `_night/live/aimoney_pages_dev_api_health.html` =
  `{"ok":false,"rev":"284163c","db":"down",` + thirteen nulls, no `health_probe_failures` key —
  the exact all-or-nothing signature. `_night/live/aimoney_pages_dev.html` (5514 bytes): light
  palette, favicon + `theme-color` + inline brand mark present (`public/index.html:9-10,16`),
  no dark-mode query anywhere under `public/`; guard tests pass (`public/tab-icon.test.mjs`,
  banner/badge-style case in `public/dashboard.test.mjs`).

## 4. Ranked findings (max 8)

Money first (owner directive, numbers from this project's own data): earned to date **none**
($0 — the only experiment in repo data is the seed's `planned` row, `d1/seed.sql:67-71`, and live
`revenue_total` is null = unknown, honestly reported); last krone arrived **never**; the single
step between here and the next payment is one spec-ad reply converting to a paid pilot (the seed
experiment's own target: `>=1 pilot at >=$500`, `d1/seed.sql:71`) — the code step is one tap
(Win), the real step is sending the 10 spec ads, which is outside the code; measured conversion
at that step **unmeasured** (zero decisions to date, `decisions_last_7d`/`vetted_last_7d` 0).
AIMoney is a tool the owner uses, not a product he sells — so findings rank by owner minutes
saved and queue drained, not by revenue projected.

### F1. Live still runs the pre-isolation health code — deploy the fix that is already committed

Evidence: live `_night/live/aimoney_pages_dev_api_health.html:1` reads
`{"ok":false,"rev":"284163c","db":"down","opportunities":null, …}` (all null, no
`health_probe_failures`); this clone at `e28a4e4` already carries the fallback —
`functions/api/[[path]].js:402` (`env.DB.batch(healthStmts).catch(() => null)`),
`:410-429` (per-probe re-run, `healthProbeFailures` named), `:479` (`db` by whether the
database answered). The dashboard then prints `agent: db down` (`public/app.js:695-700`) from a lie.
Why it costs: the owner opens a dashboard that says the database is dead while the ledger below
renders real rows — every later number is distrusted, and `verify.sh`'s `"ok":true` grep
(`deploy/verify.sh:32`) fails the rollout. Fix: deploy this HEAD to Pages (Git push to master
auto-deploys; or `deploy/deploy.sh` + `deploy/verify.sh`). After deploy, `/api/health` must show
the deployed rev, `db:"up"`, nine probes reporting, and `health_probe_failures` naming the cents
probes until F2 lands. Size S (no new code). Risk: low — covered by `api.test.mjs:1246-1319`.

### F2. CI can never apply a migration, so the new columns will never reach live D1

Evidence: `.github/workflows/deploy-worker.yml:20` runs only
`wrangler d1 execute aimoney --file=d1/schema.sql --remote` (`CREATE TABLE IF NOT EXISTS` adds no
column to an existing table), while only `deploy/deploy.sh:34-38` loops `d1/migrate-*.sql` with
duplicate-column tolerance — and CI never runs `deploy.sh`. The failing probes select
`revenue_cents`/`spent_cents` (`functions/api/[[path]].js:396-397`), added by
`d1/migrate-2026-09-20-experiment-cents.sql:5-6` and `d1/migrate-2026-09-20-revenue-source.sql:5`.
Separately, the workflow needs `CF_API_TOKEN` and `CF_ACCOUNT_ID` in this repository's secrets
(`.github/workflows/deploy-worker.yml:22-23,26-27`); without them wrangler has no credentials and
nothing in the database path can work — that secret step is the owner's, not the agent's.
Why it costs: every future schema change is dead on arrival; the two cents probes fail forever and
F1's fallback permanently reports two nulls. Fix: mirror the `deploy.sh` migration loop (with the
same tolerate-duplicate behaviour) into the workflow after the schema step, and add an early step
that fails loudly when the secrets are empty instead of letting wrangler fall back to interactive
login. Size M. Risk: medium — touches CI; test on a scratch branch run, keep the duplicate-column
tolerance so re-runs stay green.

### F3. Served HTML hardcodes `Needs review (0)` — first paint fabricates a zero

Evidence: `public/index.html:51`
`<button class="chip review" …>Needs review (<span id="review-count">0</span>…` — before JS loads,
the page states the queue is empty; the agent pill at least starts neutral (`index.html:23`
`agent: …`). A count of 0 when the truth is unknown is precisely the wrong number the money
directive bans. Why it costs: on a slow phone connection the most important truth (11 unreviewed,
oldest 6.5d) reads as "nothing to do" for the first seconds — the opposite of the five-second rule.
Fix: render `…` placeholders in the static shell and let JS fill real numbers or an error banner;
extend the existing served-page guard test to fail on a hardcoded `>0<` inside a count span.
Files: `public/index.html`, `public/dashboard.test.mjs` (or `public/tab-icon.test.mjs`). Size S.
Risk: low — static text only; keep the review-chip tooltip contract intact.

### F4. Dashboard ignores `health_probe_failures` — the owner still can't see WHICH probe fails

Evidence: the API now names failures (`functions/api/[[path]].js:479`
`...(healthProbeFailures ? { health_probe_failures: healthProbeFailures } : {})`), but
`renderRuns` (`public/app.js:691-722`) only branches on `state.health.db !== "up"` (`public/app.js:695`)
and never reads the new key — no consumer exists anywhere under `public/`.
Why it costs: after F1 ships, the pill goes green while two money probes stay null with no visible
reason; the owner must read raw JSON to learn the migration is missing. Fix: when
`health_probe_failures` is present and non-empty, append the names to the pill `title` and to the
named error banner path (one line, read-only, no new fetch); add a dashboard test asserting the
names render and that the pill stays non-red when `db:"up"` with partial failures. Files:
`public/app.js`, `public/dashboard.test.mjs`. Size S. Risk: low.

### F5. A `won` close can record $0.00 with no source — closed money isn't real

Evidence: `updateExperiment` gates `won`/`lost` on `result` + `post_mortem` only
(`functions/api/[[path]].js:329-334`); `revenue_cents`/`spent_cents` default to 0 (`:321-323`) and
`revenue_source` defaults to `""` (`:326-327`), and the same applies on create (`:280-292`). A
one-click Win with an empty $ field therefore closes as won with `($0.00 rev / $0.00 spent)` and no
`via` bit. Why it costs: the lane's money leg (`revenue_total`, `revenue_last_7d`) can show a win
that proves nothing — an amount, a date and a source are what make it real; `ended_at` already
stamps automatically (`:334`), amount and source don't. Fix: on close-as-`won` via create or
update, require a non-empty `revenue_source` unless `revenue_cents` is explicitly 0 AND a
`result` line states why (keep the API 400 shape with `fields`, mirror in the Win modal/one-click
Win inline input); `lost` stays as-is. Files: `functions/api/[[path]].js`,
`functions/api/api.test.mjs`, `public/app.js`, `public/dashboard.test.mjs`. Size M. Risk: low —
additive gate on one status; never backfill or invent a figure for existing rows.

### F6. The stall is owner review bandwidth, not missing UI — stop adding visibility

Evidence: README documents one-tap Vet/Kill/`Vet & log starter`, one-click Start/Win/Lose, stale-first
sorting with age chips, and the start-here strip (`README.md:69-79`; implemented at
`public/app.js:103-127` and tested throughout `public/dashboard.test.mjs`) — yet the measured lane
state is 11 unreviewed (oldest 6.5d), 0 decisions, 0 vetted in 7d. Every prior round made the stall
more visible and nobody acted. Why it costs: further dashboard work cannot move decisions/week; it
only adds code to maintain. Fix: ship no new visibility this round. The only code-side drain-top
lever left is a reversible worker rule with the rule written down (the worker already
link-as-supports on slug/URL match and sweeps 30d+ signals to noise, `README.md:76`) — e.g. let the
worker pre-draft (never send, never status-move) the first spec-ad outreach text onto the seed
experiment's `result`-draft field for one-tap owner review; anything that decides without the owner
stays forbidden. Size M. Risk: medium — keep every auto-step reversible and status moves human-only
(the agent "never moves status" contract, `worker/src/index.js:4-5`).

Surface-rules verdict (checked, not a finding): light-only palette (`public/styles.css:4`
`color-scheme: light`, white paper bg, no dark query); favicon 285B + icon link + theme-color
(`public/index.html:9-10`); matching inline brand mark (`public/index.html:16`); guard tests green.
Nothing to fix; the five-second gap is F3's fabricated zero, not the palette or brand.

## 5. What NOT to change

- Credentials and secrets. Never create, enter, or store one. The workflow needs `CF_API_TOKEN`
  and `CF_ACCOUNT_ID` added to this repository's GitHub secrets by the owner
  (`.github/workflows/deploy-worker.yml:22-23,26-27`); "nothing in the database path can work
  until they exist." Do not read `.env`, tokens, or `localStorage` dumps.
- The agent-never-moves-status contract: "The agent PROPOSES; the human owns the testing workflow
  (it never moves status to testing/scaling/killed)" (`worker/src/index.js:4-5`; README review
  flow `README.md:72`). No auto-vet, auto-start, auto-kill, auto-scale.
- Score math and the unreviewed cap: `score = 100 * (value * confidence * fit) / (effort + 1)`
  with `UNREVIEWED` rows capped at 6000 (`worker/src/lib.js:13-32`, `README.md:65`) — deliberate
  honesty behaviour; rescore suggestions stay one-click human-applied, never auto-applied.
- Closure evidence gate: `won`/`lost` require `result` + `post_mortem` (`functions/api/[[path]].js:331-333`);
  killed rows stay listed with post-mortems (`README.md:64`). Do not loosen; F5 only tightens `won`.
- Human decisions and money truth: never invent a revenue figure, never mark an experiment decided
  without evidence, never present a projection as a result; the seed's `>=1 pilot at >=$500`
  (`d1/seed.sql:71`) is a target, not revenue. No captcha solving, fabricated reviews, account
  creation, false claims, forbidden scraping/messaging, or financial advice.
- Data files and history: `d1/seed.sql` (runs once on empty tables), live D1 rows, and prior audit
  docs under `docs/` are read-only references.

## 6. Proposed next tasks (2–4)

1. `Ship committed health isolation to Pages so live db reads up, not down`
   Owned files: none (deploy action) + `deploy/verify.sh` for proof. Acceptance: `GET
   /api/health` shows the deployed rev with `"ok":true`, `db:"up"`, nine probes numeric, and
   `health_probe_failures` naming the cents probes; `./deploy/verify.sh` passes (its `"ok":true`
   grep, `deploy/verify.sh:32`); dashboard pill no longer reads `agent: db down`.
2. `Teach the CI workflow to apply d1/migrate-*.sql and fail loudly without secrets`
   Owned files: `.github/workflows/deploy-worker.yml`. Acceptance: workflow contains the
   migrate loop with duplicate-column tolerance (mirroring `deploy/deploy.sh:34-38`); an early
   step fails with a clear message when `CF_API_TOKEN`/`CF_ACCOUNT_ID` are empty; schema-only
   behaviour unchanged; no secret values in the file (owner adds them in repo settings).
3. `Surface failing health probe names in the agent pill and error banner`
   Owned files: `public/app.js`, `public/dashboard.test.mjs`. Acceptance: with
   `health_probe_failures:["revenue_lifetime"]` the names appear in the pill title and the named
   banner; pill stays non-red when `db:"up"`; all 247 existing tests still pass plus the new case.
4. `Replace hardcoded first-paint zeros with neutral placeholders plus a guard test`
   Owned files: `public/index.html`, `public/dashboard.test.mjs`. Acceptance: served shell shows
   `…` (not `0`) in `review-count` before JS loads; guard test fails if a count span ships a
   hardcoded digit; no visual change after data loads.
