# AUDIT 2026-09-20 round 3 — aimoney (read-only)

Lane metric: experiments reaching a decision (won/lost with post-mortem) per week, and vetted proposals that become experiments; unreviewed backlog drained.
Live snapshot used: `_night/live/aimoney_pages_dev_api_health.html` (rev 91598ff, 2026-09-21T05:42Z).

## 1. What this project is and how it runs

- Purpose: ranked list of AI-money opportunities with research briefs, experiments, and a cron research agent that proposes new rows; the human vets, tests, kills/scales.
- Entry points: `public/index.html` + `public/app.js` (dashboard); `functions/api/[[path]].js` (REST API on D1); `worker/src/index.js` (research agent: cron + `POST /run`).
- Live surfaces: `https://aimoney.pages.dev` (dashboard), `/api/health`, `/api/opportunities`, `/api/runs`, worker `GET /` status.
- Scheduled jobs: worker cron `0 */6 * * *` (`worker/wrangler.toml:9`); each tick collects signals, triages (≤6), briefs (1+1).
- Deploy: Git-connected Pages build stamps `public/release.json` via `scripts/stamp-release.sh`; `deploy/deploy.sh` applies `d1/schema.sql` + shared `deploy/apply-d1-migrations.sh` + Pages + worker; CI `.github/workflows/deploy-worker.yml` runs schema + the same shared migration script, then worker deploy; `deploy/verify.sh` gates the rollout.

## 2. End-to-end walk-through

Signal → triage → proposal → review → brief → experiment → decision → money:

1. Cron fires `scheduled` (`worker/src/index.js:576`), `runResearch` (`:239`) reaps stuck runs (`:243`), opens a run row (`:249`).
2. Collect: `hnSignals` (`:48`), `redditSignals` (`:77`), `githubSignals` (`:105`) in parallel (`:274`); one batched `INSERT OR IGNORE` (`:286`); 30d stale sweep (`:299`).
3. Take oldest 6 unprocessed (`:305`); exact-URL pre-pass links duplicates as supports with no AI call (`:313`).
4. Classify: prompt (`:354`) → `aiComplete` (`:135`, budgeted, racing a timeout) → `parseJsonLines` (`worker/src/lib.js:62`); verdict loop (`:391`) INSERTs `new` rows as `researching` + `UNREVIEWED` with score capped ≤6000 (`:419`), or `supports`/`noise`; inflow capped at 2/run, 1 while bare-without-brief > 10 (`:379`); writes flush via `flushVerdictWrites` with per-write fallback (`:222`,`:460`).
5. Brief: top-scored bare row, or oldest-unreviewed-first past 48h (`:471`); one extra oldest-unreviewed bare row past 48h on cron (`:519`); shared `buildBriefPrompt`/`parseBriefJson` (`:201`,`:212`); run log carries mode + `src_fail`/`brief:failed`/`verdict:N_failed` (`:562`); D1-dead ticks log `cron-failed` to the tail (`:570`).
6. Health: 11 probes, one `env.DB.batch` (`functions/api/[[path]].js:459`), per-probe isolation fallback naming `health_probe_failures` + column detail (`:481`), self-migration retry of money probes (`:519`), payload (`:586`).
7. Review: dashboard chip → `GET /api/opportunities?unreviewed=1&sort=oldest` (`[[path]].js:113`); Vet (`public/app.js:421`) clears `UNREVIEWED`, appends `[YYYY-MM-DD vetted]` (`:431`) which the `vetted_7d` probe counts (`[[path]].js:468`); Kill requires a post-mortem; Vet-&-starter (`app.js:450`) composes Vet + planned experiment + flip to `testing`.
8. Experiment: `POST /experiments` (`[[path]].js:324`); Start stamps `started_at` (`:397`); Win/Lose require `result` + `post_mortem` (`:398`), stamp `ended_at`, append the `$X rev / $Y spent` outcome-ledger line to the parent (`:408`); `decisions_last_7d` counts won/lost closed in 7d (`:465`), revenue probes SUM cents (`:466`).
9. Where it breaks or goes silent: the human step. Cron is alive (`hours_since_last_ok_run` 5.7) and the machinery reports honestly, but 11 rows sit unreviewed (oldest 173.4 h), 19/27 have no brief, 2 experiments sit `planned`, and `decisions_last_7d`/`vetted_last_7d` are 0 — nothing has moved through steps 7–8 in 7+ days. Second suspect: brief throughput (finding 8).

## 3. Health signals measured here

- Test suite: `npm test` → `node --test` over 7 files, exit code 0. Static count of `it("…")` subtests: 315 (lib 16, worker-index 70, api 94, migrations 5, deploy 14, tab-icon 5, dashboard 111); visible TAP output shows every executed suite `ok`, zero `not ok`. (Sandbox denied re-running a summary wrapper and reading the saved output tail outside the workspace, so the totals above are exit-code + static count, stated honestly.)
- Compile: N/A `compileall` (JS repo). All source modules load under the suite, including ESM `functions/api/[[path]].js` (one `MODULE_TYPELESS_PACKAGE_JSON` warning, non-failing).
- TODO density: 0 matches for `TODO|FIXME|XXX|HACK` across `public functions worker d1 deploy scripts`.
- Dead code: none material. Duplicated logic: classify prompt ×2 (finding 5), brief INSERT ×2 (finding 6), Vet notes-tag ×2 (finding 7).
- Positive controls present: `d1/migrations.test.mjs:117` ("withholding any one migration file breaks convergence"); isolation tests fail one probe and assert the rest report (`functions/api/api.test.mjs:1344`).
- Line endings: `functions/api/[[path]].js` is CRLF (every line matches `\r`). Implementers: replace whole lines, re-read after edit.
- Surface rules: pass — light palette only (`public/styles.css:4` `color-scheme: light`, no dark branch), icon + theme-color (`public/index.html:9`), inline brand mark (`:16`), guard tests (`public/tab-icon.test.mjs`, `public/dashboard.test.mjs:161`).

Money-first answers (owner directive): earned to date **none** — `revenue_total` is null (unknown: migration disabled) and no experiment has ever closed (`experiments_by_status {"planned": 2}`, zero won/lost), so no revenue row can exist; last krone arrived **never**. This lane is a tool the owner uses, not a product he sells — it ranks by decisions/week and vetted→experiment conversion, both currently 0. Single step to the next payment: a human vets one opportunity and starts its zero-spend starter (Vet & log starter → Start). Measured conversion at that step: unmeasured (zero attempts).

## 4. Ranked findings (max 8)

1. **The queue has not moved in 7 days; that is the whole deficit.**
   Evidence: live health `{"unreviewed":11,"bare_without_brief":19,"vetted_last_7d":0,"decisions_last_7d":0,"experiments_by_status":{"planned":2},"oldest_unreviewed_age_h":173.4}`.
   Why it costs: the lane metric is decisions/week and vetted→experiments — both 0 across every snapshot; machinery improvements cannot move it.
   Fix: do the pipeline work as task 1 — review 11 with verdicts in the store's own notes/tags, brief or concretely block the 19, next-step the 2 planned, name one best candidate. No schema or code change. Size M (human time). Risk: none — verdicts are reversible text.
2. **Live revenue fields are null because the self-migration switch is off — owner action.**
   Evidence: live `{"health_probe_failures":["revenue_week","revenue_lifetime"],"schema_missing_columns":["revenue_cents","spent_cents"],"schema_migration":"disabled (set ALLOW_SCHEMA_MIGRATION=1 to add missing columns)"}`; gate at `functions/api/[[path]].js:53`.
   Why it costs: the money leg of the lane metric is invisible; every revenue figure reads unknown.
   Fix: owner sets Pages env var `ALLOW_SCHEMA_MIGRATION=1`; the next health call ADDs exactly the two columns (`[[path]].js:27`) and reports numbers on the same call. Size S. Risk: low — ADD COLUMN with DEFAULT, once per isolate, no endpoint.
3. **CI still cannot converge the schema: the repository has no Cloudflare secrets.**
   Evidence: `.github/workflows/deploy-worker.yml:20` fail-fast on empty `CF_API_TOKEN`/`CF_ACCOUNT_ID`; migration step `:33` never runs without them.
   Why it costs: `revenue_source` can never reach live D1 via CI, so experiment writes keep 503ing (`[[path]].js:614`); the deploy path is correct but unfireable.
   Fix: owner adds `CF_API_TOKEN` and `CF_ACCOUNT_ID` to repo Settings → Secrets → Actions; nothing else changes. Size S (owner). Risk: none to code.
4. **PATCH /experiments writes unbounded text; create and PATCH /opportunities truncate.**
   Evidence: `functions/api/[[path]].js:382` assigns `name/hypothesis/…/post_mortem` via bare `String(b[f])`, while create slices (`:356`) and `updateOpportunity` enforces `OPP_TEXT_BOUNDS` (`:216`).
   Why it costs: one oversized PATCH can bloat rows past the 8000-char newest-kept idiom every other writer honors; inconsistent guards hide data-quality bugs.
   Fix: mirror the same bounds table in `updateExperiment` plus a test mirroring `api.test.mjs:1737`. Touch `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Size S. Risk: low — pure tightening to documented limits.
5. **`/debug-classify` prompt has already drifted from the triage prompt it debugs.**
   Evidence: live prompt `worker/src/index.js:354` (with `Rules: DEFAULT TO NOISE…`) vs debug probe `:626` (rules paragraph absent, money-keys sentence reworded).
   Why it costs: debug verdicts do not reproduce cron verdicts, so the probe misleads exactly when triage quality is questioned.
   Fix: extract a shared `buildClassifyPrompt(opps, fresh)` beside `buildBriefPrompt`, call it from both sites, assert byte-identical output in `worker/src/index.test.js`. Size S. Risk: low.
6. **Brief INSERT is duplicated between the main and extra passes.**
   Evidence: `worker/src/index.js:496` vs `:544` — only prompt/parse were shared (`buildBriefPrompt`, `parseBriefJson`); the non-empty guard + INSERT repeat.
   Why it costs: the "never store an empty brief" guard can diverge by path; two edits per brief-schema change.
   Fix: shared `insertBrief(env, opportunityId, parsed, sigs)` returning bool; both passes call it; existing brief tests stay green. Touch `worker/src/index.js`, `worker/src/index.test.js`. Size S. Risk: low.
7. **Vet notes-tag built twice; the tag is the health contract.**
   Evidence: `public/app.js:431` (`vetOpportunityInner`) vs `:460` (`vetAndLogStarterInner`) — byte-identical `[day vetted]` strings today; `vetted_7d` probe counts that tag (`[[path]].js:468`).
   Why it costs: one divergent edit silently breaks `vetted_last_7d` (a lane-metric input).
   Fix: one `vettedNotes(notes)` helper used by both; the byte-identical-tags test (`public/dashboard.test.mjs:751`) pins it. Size S. Risk: negligible.
8. **Bare-without-brief is static at 19 while cron is alive — the brief pass is the suspected silent break.**
   Evidence: `bare_without_brief:19` + `hours_since_last_ok_run:5.7` (cron ticking) + oldest unreviewed 173 h (extra-brief gate at `worker/src/index.js:521` should fire every tick: up to 2 briefs × 4 ticks/day).
   Why it costs: unbriefed rows cannot be decided in under a minute; the review queue stays unactionable.
   Fix: measure first (task 4) — briefs/week and `brief:failed` rate from `/api/runs` — before touching code; if failures cluster, fix that cause, not capacity. Size S. Risk: none (read-only).

## 5. What NOT to change

- `ALLOW_SCHEMA_MIGRATION=1` is the owner's switch: "Default-off: unset changes nothing" (`functions/api/[[path]].js:23`). One line for him: Pages → Settings → Environment variables → add `ALLOW_SCHEMA_MIGRATION=1`, redeploy.
- `CF_API_TOKEN` / `CF_ACCOUNT_ID` repo secrets are his to add (finding 3). One line: repo Settings → Secrets → Actions → add both, re-run Deploy research worker.
- Never spend money, create accounts, enter payment details, sign up, or accept terms — all his, per the brief's hard boundaries.
- Never touch the production database directly (`wrangler d1 execute --remote`); write through the app's paths. Applying migrations to live D1 is his action.
- `revenue_source` is deliberately NOT auto-migrated: "write-only columns are never auto-migrated" (`README.md:83`); experiment writes 503 naming only that column by design (`[[path]].js:86`).
- The agent never moves status: "it never moves status to testing/scaling/killed" (`worker/src/index.js:5`); `researching → testing` "is a human decision" (`README.md:72`). Do not automate it.
- Never invent a revenue figure or mark an experiment decided without evidence; never present projections as results.

## 6. Proposed next tasks

1. **Review 11 unreviewed opps, brief/block the 19 bare, next-step 2 planned, name 1 best** — owned files: none (live data via dashboard + API paths only). Acceptance: `/api/health` unreviewed < 11 with each verdict + reason in the row's own notes/tags; every bare row has a brief or a recorded concrete blocker; each planned experiment has a next step + owner (owner steps as one actionable line); report names the single best candidate with its case, counts reviewed/rejected + commonest reason, briefs written, and owner-only next actions.
2. **Bound PATCH /experiments text fields exactly like create (mirror OPP_TEXT_BOUNDS)** — owned files: `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Acceptance: new test mirroring `api.test.mjs:1737` passes; full `npm test` green; CRLF-safe whole-line edits verified by re-read.
3. **Share one classify-prompt builder between triage and /debug-classify** — owned files: `worker/src/index.js`, `worker/src/index.test.js`. Acceptance: test asserts both call sites emit byte-identical prompts (incl. DEFAULT-TO-NOISE rules); full `npm test` green.
4. **Measure brief throughput vs the bare backlog from /api/runs (read-only)** — owned files: none (or a note in the next audit). Acceptance: report briefs/week, `brief:failed`/`src_fail` rate, and a verdict: brief pass failing (name cause) vs working (name drain date for the 19).

## Round notes (method, blockers)

- Read-only as delegated: no git writes, no network, no installs, no edits to existing files; only this file created.
- Blockers: sandbox denied `git log/status` (cannot paste tree-status evidence; the only file I created in the clone is this one; throwaway notes went to `/tmp`, outside the repo) and denied executing a `/tmp` summary wrapper (test totals reported as exit-code 0 + static `it()` count instead of TAP tail).
- Live queue contents (the 27 rows) were not fetchable offline, so the best-candidate case in task 1 must be built from live data at execution time; from repo seed data alone the highest-EV row is `ai-ugc-ads-service` (score 16000, $2–8k/mo, $0–200 capital, briefed week-1 spec-ad sprint, `d1/seed.sql:9`) — to be confirmed or overturned against the live 11.
