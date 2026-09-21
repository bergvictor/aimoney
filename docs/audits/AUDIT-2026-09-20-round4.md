# AUDIT-2026-09-20-round4 — aimoney (read-only lane)

Scope note: delegated path `/mnt/c/coding-projects/_workspace/trackb-aimoney-r4` resolves in this
session to `/root/coding-projects/_workspace/trackb-aimoney-r4`; all work was done there. No git
writes, no network, no installs, no edits to existing files, no `.env`/secret reads. This file is
the only file created. Nothing was changed, so there is no CI file:line "changed" to report; the
step that must change is `.github/workflows/deploy-worker.yml:20` (Finding 1). New file uses LF to
match committed (HEAD) convention; the worktree checkout itself is CRLF (Finding 7).

## 1. What this project is and how it runs

- Purpose: AIMoney Lab, a personal tool the owner uses (not a product he sells) — a scored ledger of AI-money opportunities, research briefs, and an experiment tracker that kills/scales ideas on evidence.
- Entry points: static dashboard (`public/index.html`, `public/app.js`, 1361 lines); Pages Functions REST API (`functions/api/[[path]].js`); research Worker (`worker/src/index.js`, shared `worker/src/lib.js`).
- Live surfaces: `https://aimoney.pages.dev/` (dashboard), `https://aimoney.pages.dev/api/health` (JSON), research worker `https://aimoney-research.levitinvlad.workers.dev/`; one D1 database `aimoney` bound as `DB` (`wrangler.toml:13-16`, `worker/wrangler.toml:11-14`).
- Scheduled jobs: Worker cron `0 */6 * * *` (`worker/wrangler.toml:9`) → collect signals → AI triage → brief bare rows; manual triage-only `POST /run` (202, `briefs_skipped:true`); no other schedulers.
- Deploys: Pages Git-connected build (`scripts/stamp-release.sh` stamps `public/release.json` from `CF_PAGES_COMMIT_SHA`) plus research worker via CI (`.github/workflows/deploy-worker.yml:24`) or `./deploy/deploy.sh` (D1 → Pages → worker), verified by `./deploy/verify.sh`.

## 2. End-to-end walk-through

Main flow A — signal → proposal → brief (all in `worker/src/index.js` unless noted). Cron fires
`scheduled` (:536) → `runResearch(env,"cron")` (:195): reaps stuck runs (:199-204), opens an
`agent_runs` row (:205-214), collects HN/Reddit/GitHub in parallel (`hnSignals` :47, `redditSignals`
:76, `githubSignals` :104 via `timedJson` :35; `Promise.allSettled` :230; per-source failure named in
`src_fail` :72/:100/:235). Signals batch-insert (:242-245), one heartbeat (:247-250), >30d
unprocessed swept to noise (:255-259), oldest-first take of 6 (:261-263), exact-URL supports
pre-pass with no AI call (:269-295), one Mistral classify call (:306-327, `aiComplete` :134,
`parseJsonLines` in `worker/src/lib.js:62`). Validated verdicts (:339-407): `new` INSERTs a
`researching` row with `UNREVIEWED` + capped score (:367-377, at most 2/run via `MAX_NEW_PER_RUN`
:16/:356; slug collision links as supports :386-393); `supports` appends a notes line (:395-403);
`noise` just marks processed (:404-406); all verdict writes flush as one `env.DB.batch` (:408).
Cron then briefs one bare row (:410-469, INSERT :458-466) plus one extra oldest-unreviewed row past
48h (:476-524), and finishes the run log once (:527). Manual path `POST /run` (:592-601) runs
collect+triage only and always skips briefs (:228).

Main flow B — review → vet → experiment → decision. Dashboard `refresh()` (`public/app.js:1304`)
loads `/api/opportunities` (`functions/api/[[path]].js:491` → `listOpportunities` :44-86, capped
scores, `needs_review` bit, brief excerpts) and `/api/health`; the review chip lists UNREVIEWED
oldest-first (`refreshReview`, `public/app.js:242`). Vet (`public/app.js:406`) / Kill (:487) PATCH
`updateOpportunity` (`[[path]].js:138-179`); Start (`public/app.js:582`) PATCHes
`updateExperiment` (`[[path]].js:306-359`), whose closure gate requires `result` + `post_mortem` for
`won`/`lost`, stamps `ended_at`, and appends a one-line `$X rev / $Y spent` outcome to the parent
notes (:340-347). Health (`[[path]].js:374-483`) answers from one 10-statement batch (:402) with an
isolation fallback that re-runs statements individually and names failures (:410-432, response :482).

Where it most often breaks or goes silent. (1) Live D1 is missing the three 2026-09-20 columns, so
health probes 5–6 fail and the four money fields read null (Finding 1; live snapshot below). (2) The
human bottleneck: 11 unreviewed, oldest 169.9h (~7d), 19 of 27 rows without a brief, 2 planned / 0
running / 0 decided experiments, `vetted_last_7d` 0 — the queue drains only at the bottom. (3) Schema
can never converge from CI: no repo secrets plus a schema-only CI step (Finding 1). (4) Quiet-tick
sources: unauthenticated Reddit search (`index.js:82-84`) is 429-prone; `src_fail` accounting
(:235, :527) is the only signal, visible solely in the research log.

## 3. Health signals measured here

- `npm test` (this session, repo root): exit 0 — `tests 261, suites 91, pass 261, fail 0, cancelled
  0, skipped 0, duration_ms 1646.979725`. Matches `_night/tests-baseline.log` counts exactly
  (261/91/0 fails there too, `duration_ms 257.7824` on Windows; slower here under the sandbox proxy,
  same verdict). Includes the round-1 probe-isolation suite (4 tests: one bad probe reports 9 +
  names it, `db:up` when any probe answers, no failures key on spurious reject).
- `node --check public/app.js`: exit 0. The three ESM sources (`functions/api/[[path]].js`,
  `worker/src/index.js`, `worker/src/lib.js`) are imported live by the suite — any syntax error
  would fail every suite that touches them.
- `python3 -m compileall`: not applicable — zero `.py` files; the repo is JS/SQL/sh-only (verified
  by full directory listings of `public functions worker d1 deploy scripts docs .github`).
- TODO density: 0 matches for `TODO|FIXME|XXX|HACK` across `public functions worker deploy scripts
  d1`. Dead code: none found beyond the previously-removed rails (round-1 commit confirms removal);
  live near-duplication is Finding 8 plus two documented mirrors (`centsDollars` in
  `[[path]].js:24` ↔ `moneyCents` in `public/app.js:53`, noted at `[[path]].js:23`; local `clamp10`
  in `[[path]].js:16-20` vs `worker/src/lib.js:4` with a different signature).
- Sizes (`wc -l`): app.js 1361, index.js 605, index.html 121, styles.css 215, lib.js 77, schema.sql
  102, seed.sql 71, deploy.sh 61, verify.sh 63 (2676 total). `ls -l public`: favicon.svg 285 bytes
  (< 2 KB), release.json 85 bytes.
- Surface rules: COMPLIANT, no finding. Served HTML carries icon + `theme-color`
  (`public/index.html:9-10`), inline brand mark (:16), neutral `…` placeholders (:23, :52);
  `styles.css:4` declares `color-scheme: light` with no dark branch; the guard suites
  (`tab-icon`, 5 tests) are green. Live HTML snapshot is byte-consistent with serving the repo file
  minus CR bytes (5637 − 121 lines = 5516 served), i.e. LF-normalized on the edge.
- Tree state: `git status --short` showed 32 modified files BEFORE this audit, but
  `git diff --ignore-cr-at-eol --stat` is empty and `file(1)` reports CRLF worktree files — the
  entire diff is line endings (HEAD is LF). So the acceptance "only that new file" cannot literally
  hold for `git status`; the content-accurate check is `--ignore-cr-at-eol`, under which this audit
  adds exactly one file. Log HEAD: `bca64b4` round 3 (2026-09-21 04:17 +0200); live `rev` was
  `ac8e652` (round 2) at snapshot time 02:17:42Z — the snapshot coincides with the round-3 commit,
  so no stale-deploy lag is proven (round 2 shipped within ~18 min of its commit).
- Positive controls (absences claimed above): the TODO/dark-mode regex DOES match — guard-test
  strings in `public/dashboard.test.mjs:164` and `public/tab-icon.test.mjs:66-76`, and
  `color-scheme: light` in `public/styles.css:4` — so zero matches in shipped source means absent,
  not a broken matcher. The suite executed 261 tests with 0 skipped, so "all green" has a non-zero
  denominator. `verify.sh`'s `renderLedger` grep has a live target (`public/app.js:136` + 8 call
  sites). Seed count was read directly (`d1/seed.sql:6-17`, 12 rows), not via a count query.

## 4. Ranked findings (max 8)

Ranking basis is the lane metric (experiment decisions/week, vetted→experiment conversion,
unreviewed backlog drained) under the money-first directive; surface-rule findings would rank here
but there are none (see section 3).

1. **CI can never converge the schema, so the four money fields are permanently null.**
   Evidence: `.github/workflows/deploy-worker.yml:20` runs `wrangler d1 execute aimoney
   --file=d1/schema.sql --remote` and nothing else; `d1/schema.sql:5,32,48,72,88` is all `CREATE
   TABLE IF NOT EXISTS` (no-op on existing tables); the three live-missing columns exist only in
   `d1/migrate-2026-09-20-experiment-cents.sql:5-6` and `d1/migrate-2026-09-20-revenue-source.sql:5`,
   applied solely by `deploy/deploy.sh:34-38`, which CI never runs. Live
   `https://aimoney.pages.dev/api/health` proves it: `"decisions_last_7d":null,
   "revenue_last_7d":null,"revenue_total":null,"spent_total":null,
   "health_probe_failures":["decisions_revenue_week","revenue_lifetime"]` — exactly the two probes
   that `SUM(revenue_cents)`/`SUM(spent_cents)` (`[[path]].js:396-397`). Round 3's commit message
   confirms this CI task was skipped again, so the gap is now three rounds old.
   Why it costs: the lane metric (decisions/week) and every money figure are unreadable, and NO
   future schema change can reach live D1 through CI.
   Fix: after `:20`, execute `d1/migrate-*.sql` in fixed sorted order from one list shared with
   `deploy.sh` (a tiny `deploy/migrate.sh` both call, or a mirrored loop with a comment pointer so
   they cannot drift); tolerate only the duplicate-column error (see Finding 2); fail the job with
   a clear message when `CF_API_TOKEN`/`CF_ACCOUNT_ID` are empty instead of falling into wrangler's
   interactive-login error. Owner still adds the two secrets; no `--remote` run from any audit lane.
   Size M. Risk: low once idempotent (all migrations are additive with defaults).

2. **`deploy.sh` calls EVERY migration failure "already applied".**
   Evidence: `deploy/deploy.sh:37`: `$WRANGLER d1 execute aimoney --file="$f" --remote || echo
   "==> D1: $f already applied (continuing)"` — any error (syntax, wrong table, auth) prints
   success and the rollout stays green.
   Why it costs: schema drift becomes silent; a broken migration looks identical to a converged
   schema from outside, compounding Finding 1.
   Fix: capture the command output, allow only the duplicate-column message
   (`duplicate column`/`already exists`, matched narrowly), and `exit 1` otherwise; alternatively
   pre-check `PRAGMA table_info(experiments)` before each `ALTER`. A second run must be a clean
   no-op and a genuinely broken migration must fail the deploy. Files: `deploy/deploy.sh` (and the
   shared list from Finding 1). Size S. Risk: low.

3. **Health names the failing probe but not the missing column.**
   Evidence: `functions/api/[[path]].js:410-424` — the isolation fallback's `catch {}` discards the
   error object, and `:482` emits only `health_probe_failures:["decisions_revenue_week",...]`; a
   reader cannot see that a migration is unapplied without opening the source.
   Why it costs: every future schema drift repeats this exact multi-round diagnosis from scratch.
   Fix: capture the rejection reason per probe, extract only `no such column: <name>` (narrow
   regex, never echo raw SQL/errors into the public body), and attach it, e.g.
   `health_probe_detail:{"revenue_lifetime":"revenue_cents"}`. Files: `functions/api/[[path]].js`,
   `functions/api/api.test.mjs` (reject one probe with a no-such-column error, assert the column
   is named and the other nine report). Size S. Risk: low.

4. **No test exercises migrations over an old schema, so this bug class survives every suite.**
   Evidence: `functions/api/api.test.mjs` stubs D1 (`oneBadProbeDB`-style fakes); nothing creates an
   `experiments` table from an older `schema.sql`, applies `schema.sql` + `d1/migrate-*.sql`, and
   asserts every column the probes read (`revenue_cents`, `spent_cents`, `ended_at`,
   `revenue_source`). A fresh-`CREATE TABLE` test cannot see this bug — 261 green tests prove that.
   Why it costs: the next added column will ship, pass CI, and null its fields the same way.
   Fix: add a convergence test that builds the pre-migration table, applies base schema plus each
   migration in order (via a real SQLite engine on the runner, or a static column-coverage parse of
   probe `SELECT`s against schema+migrations if no engine is available), and asserts all probed
   columns exist — with the positive control run both ways (withhold one migration ⇒ must fail).
   Files: `functions/api/api.test.mjs` (or a new `d1/` test). Size M. Risk: low.

5. **`experiments_by_status` has no probe-failure guard: a dead probe 3 reports `{}` ("no experiments").**
   Evidence: `[[path]].js:446,472-473` build `experiments_by_status` unconditionally, and the `:482`
   response guards probes 0,1,2,5,6,7,8,9 with `probeFailed(i)` but never probe 3 (probes 1-oldest
   and 4-freshness default to `null` naturally on failure, so only probe 3 fabricates a value —
   `{}` is byte-identical to the genuine empty state).
   Why it costs: an outage of that probe masquerades as "zero experiments", the exact
   wrong-number-instead-of-unknown the money directive bans.
   Fix: emit `probeFailed(3) ? null : experiments_by_status`, add the matching `typeof` guard in
   `public/app.js` where the board reads it, and extend the isolation suite with a probe-3 failure
   case. Files: `functions/api/[[path]].js`, `public/app.js`, `functions/api/api.test.mjs`. Size S.
   Risk: low.

6. **`verify.sh` prints the live revision but never checks it.**
   Evidence: `deploy/verify.sh:31` greps only `'"project":"aimoney"'`, and `:39-40` fetch
   `/release.json` and `echo "==> live revision: ${REV}"` with no comparison to the deployed
   commit, no retry, and no rejection of an HTML (SPA-fallback) body. Meanwhile the committed
   `public/release.json:1` is the placeholder `{"project":"aimoney","revision":"dev-undeployed",
   ...}`, and the Pages build command that overwrites it lives in the Cloudflare dashboard, not in
   this repo (only documented at `deploy/public-surfaces.json:9`) — if it ever stops running, the
   placeholder serves verbatim. (This surface's revision source already exists — `release.json` +
   health `rev` — so no second source of truth is needed.)
   Why it costs: a stale edge, queued build, or skipped stamp step looks identical to a successful
   deploy; the fleet-wide "surface cannot prove what it serves" gap applies here by verification,
   not by missing file.
   Fix: pass the expected short SHA into `verify.sh`, fetch `/release.json?cb=<ts>`, require JSON
   parse plus `revision == expected`, retry a stale revision a bounded number of times, and fail
   immediately on an HTML body or a wrong revision. Files: `deploy/verify.sh` (document the
   dashboard build command string alongside). Size S. Risk: low.

7. **The whole tree diffs on line endings; edited files now mix LF into CRLF; CRLF shebangs break `./` on Linux.**
   Evidence: `git status --short` lists 32 modified files while `git diff --ignore-cr-at-eol
   --stat` is empty; `file(1)` reports CRLF worktree files; the round-2 commit message documents
   "inserted lines use LF inside CRLF files"; `deploy/deploy.sh:1`, `deploy/verify.sh:1`,
   `scripts/stamp-release.sh:1` carry CRLF after `#!/usr/bin/env sh`, which fails direct execution
   on Linux (`sh\r`). This is the same family as the overnight `export→port` mangling.
   Why it costs: `git status` acceptance is unreadable, every future edit risks off-by-CR
   replacement bugs, and the scripts cannot run via `./` on Linux CI as-is.
   Fix (owner decision, not this lane): add `.gitattributes` (`* text=auto`, `*.sh eol=lf`) plus
   one normalization commit; until then, match each file's actual endings and prefer whole-line
   replacements. Files: `.gitattributes` (new), one-time normalization. Size S (config) / M
   (normalize). Risk: medium for the normalization (touches every file; keep it a lone commit).

8. **The worker's brief-write pass is duplicated (~30 lines × 2) and will drift.**
   Evidence: `worker/src/index.js:440-468` (first brief: prompt, parse, empty-brief guard :457,
   `INSERT INTO briefs` :458-466) vs `:491-520` (extra brief: same shape, guard :510, INSERT
   :511-519) — prompt text, guards, and bind order maintained in two places.
   Why it costs: the next prompt/guard/schema fix lands in one copy and silently misses the other;
   with briefs already the scarcest output (19 of 27 rows bare), a half-applied brief fix directly
   slows the review queue.
   Fix: extract one `briefOne(env, state, target, sigs, retries)` helper (keeping `retries:1` vs
   `retries:0` as a parameter and the distinct bare/extra-bare selection queries at the call
   sites); existing worker tests should pass unchanged. Files: `worker/src/index.js`. Size S.
   Risk: low.

## 5. What NOT to change

- Credentials and remote writes. The repo has no `CF_API_TOKEN`/`CF_ACCOUNT_ID`; adding them to
  this repository's secrets is the owner's action — never create, enter, print, or store a
  credential. Likewise never run `wrangler d1 execute --remote`, a migration, or any write against
  production D1 from an audit/implementation lane; applying the pending migrations to live D1 is
  the owner's action. `ADMIN_TOKEN` rotation stays manual per `README.md:85-88`.
- The human-owned review boundary. `worker/src/index.js:4-5`: "The agent PROPOSES; the human owns
  the testing workflow (it never moves status to testing/scaling/killed)." Vet/Kill/vetted-tag,
  `researching → testing`, and every close decision stay human taps; never auto-transition status,
  never mark an experiment decided without evidence, never invent a revenue figure.
- Deliberate board semantics. `README.md:64`: "Killed strategies stay on the board with their
  post-mortem — that is the point." Score formula `score = 100 * (value * confidence * fit) /
  (effort + 1)`, the `UNREVIEWED` ≤6000 cap (`worker/src/lib.js:21-29`), inflow cap 2/run
  (`worker/src/index.js:16`), `MAX_AI_CALLS = 4` (:17), manual brief-skip (:228, :592-601), and the
  <30s `waitUntil` budget (:7-11) are all documented load-bearing rails — tune only with owner
  sign-off and a test pinning the new bound.
- Anything needing a login, payment, or platform permission: Reddit/GitHub/HN terms (no scraping or
  messaging a platform forbids), Cloudflare dashboard settings (Pages build command, env vars),
  and the `.gitattributes` normalization in Finding 7 (owner decision; lone commit).

## 6. Proposed next tasks (2–4)

Money-first answers, in this project's own numbers, before any task. Earned to date: none — live
health shows `experiments_by_status:{"planned":2}` with zero `won`/`lost` ever, and the seed ships
one planned $0 experiment (`d1/seed.sql:67-71`); last krone arrived: never. This project is a tool
the owner uses, not a product he sells, so tasks rank by owner-time saved and decisions unblocked.
Single step to the next payment: close one experiment `won` with `revenue_cents > 0` (the $0 spec-ad
sprint, `ai-ugc-ads-service`, is the named first candidate); conversion at that step is unmeasured
(zero closures to date). The bottleneck is outside the code: 11 unreviewed (oldest ~7d), 19 of 27
without a brief, `vetted_last_7d` 0 — no code change vets a row for him.

1. `CI runs sorted d1/migrate-*.sql after schema.sql, failing loud on empty secrets` (79 chars).
   Owned files: `.github/workflows/deploy-worker.yml` (step after `:20`; optionally a shared
   `deploy/migrate.sh` also called by `deploy/deploy.sh`). Acceptance: the workflow applies base
   schema then every `d1/migrate-*.sql` in sorted order; a re-run is a clean no-op (only
   duplicate-column tolerated); a deliberately broken migration fails the job; empty
   `CF_API_TOKEN`/`CF_ACCOUNT_ID` fails fast with a named message (no interactive-login hang);
   report the exact file:line changed. No `--remote` execution from the lane.
2. `Health names the missing column when a probe fails on schema drift` (66 chars). Owned files:
   `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Acceptance: a probe rejecting with a
   no-such-column error yields the column name in the response while the other nine probes still
   report and `db` reads `up`; the failures key stays absent when every probe answers; no raw SQL
   or driver verbiage leaks into the public body.
3. `Old-schema migration-convergence test guards every probed column` (63 chars). Owned files: API
   test file and/or a new `d1/` test. Acceptance: starting from a pre-migration `experiments`
   table, `schema.sql` + ordered migrations end with `revenue_cents`, `spent_cents`,
   `revenue_source`, and `ended_at` all present; withholding any one migration file makes the test
   fail (positive control); all 261 existing tests stay green.
4. `deploy.sh tolerates only duplicate-column migration errors` (57 chars). Owned files:
   `deploy/deploy.sh`. Acceptance: re-running migrations exits 0; a syntactically broken migration
   exits non-zero with the driver error surfaced (not "already applied"); seed-guard and
   Pages/worker steps behave exactly as today.
