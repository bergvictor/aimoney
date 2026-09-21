# AUDIT-2026-09-20-round1 — aimoney (read-only lane)

Scope note: delegated path `/mnt/c/coding-projects/_workspace/trackb-aimoney-r1` resolves in this
session to `/root/coding-projects/_workspace/trackb-aimoney-r1`; all work was done there. No git
writes, no network, no installs, no edits to existing files, no `.env`/secret reads (no `AGENTS.md`,
`CLAUDE.md`, or `CONTRIBUTING` exists in this repo; `README.md` was read first). This file is the
only file created. Nothing was changed, so there is no "CI file:line changed" to report; the steps
that must change are cited per finding. New file uses LF to match HEAD convention; the worktree
checkout itself is CRLF (Finding 5).

## 1. What this project is and how it runs

- Purpose: AIMoney Lab, a tool the owner uses (not a product he sells) — a scored ledger of AI-money opportunities, research briefs, and an experiment tracker that kills/scales ideas on evidence.
- Entry points: static dashboard (`public/index.html`, `public/app.js` 1361 lines); Pages Functions REST API (`functions/api/[[path]].js` 520 lines); research Worker (`worker/src/index.js` 605 lines, shared `worker/src/lib.js` 77 lines).
- Live surfaces: `https://aimoney.pages.dev/` (dashboard), `https://aimoney.pages.dev/api/health` (JSON), research worker `https://aimoney-research.levitinvlad.workers.dev/`; one D1 database `aimoney` bound as `DB` (`wrangler.toml:13-16`, `worker/wrangler.toml:11-14`).
- Scheduled jobs: Worker cron `0 */6 * * *` (`worker/wrangler.toml:9`) → collect signals → AI triage → brief bare rows; manual triage-only `POST /run` (202, `briefs_skipped:true`); no other schedulers.
- Deploys: Pages Git-connected build (`scripts/stamp-release.sh:5-8` stamps `public/release.json` from `CF_PAGES_COMMIT_SHA`) plus worker via CI (`.github/workflows/deploy-worker.yml:54`) or `./deploy/deploy.sh` (D1 → Pages → worker), verified by `./deploy/verify.sh`.

## 2. End-to-end walk-through

Main flow A — signal → proposal → brief (all in `worker/src/index.js` unless noted). Cron fires
`scheduled` (:536) → `runResearch(env,"cron")` (:195): reaps stuck runs (:199-204), opens an
`agent_runs` row (:205-214), collects HN/Reddit/GitHub in parallel (`hnSignals` :47, `redditSignals`
:76, `githubSignals` :104 via `timedJson` :35; `Promise.allSettled` :230; per-source failure named in
`src_fail` :72/:100/:235). Signals batch-insert (:242-245), one heartbeat (:247-250), >30d
unprocessed swept to noise (:255-259), oldest-first take of 6 (:261-263), exact-URL supports
pre-pass with no AI call (:269-295, `exactUrlTarget` :166), one Mistral classify call (:306-327,
`aiComplete` :134, `parseJsonLines` in `worker/src/lib.js:62`). Validated verdicts (:339-407): `new`
INSERTs a `researching` row with `UNREVIEWED` + capped score (:367-377, at most 2/run via
`MAX_NEW_PER_RUN` :16/:356; slug collision links as supports :386-393); `supports` appends a notes
line (:395-403); `noise` just marks processed (:404-406); verdict writes flush as one `env.DB.batch`
(:408). Cron then briefs one bare row (:435-468, INSERT :458-466) plus one extra oldest-unreviewed
row past 48h (:476-524), and finishes the run log once (:527). Manual `POST /run` (:592-601) runs
collect+triage only and always skips briefs (:228, 202 with `briefs_skipped:true` :600).

Main flow B — review → vet → experiment → decision. Dashboard `refresh()` (`public/app.js:1304` via
`refreshTargets` :1314) loads `/api/opportunities` (`functions/api/[[path]].js:499` →
`listOpportunities` :44-86, capped scores, `needs_review` bit, brief excerpts) and `/api/health`
(:374-490); the start-here strip renders the #1 pick (`renderStartHere`, `public/app.js:103`) and
the review chip lists UNREVIEWED oldest-first (`refreshReview`, `public/app.js:242`). Vet
(`public/app.js:406`, inner :419) / Kill (:487, inner :499) PATCH `updateOpportunity`
(`[[path]].js:138-179`); Start (`public/app.js:582`) PATCHes `updateExperiment` (`[[path]].js:306-359`),
whose closure gate requires `result` + `post_mortem` for `won`/`lost`, stamps `ended_at`, and appends
a one-line `$X rev / $Y spent` outcome to the parent notes (:339-348). Health answers from one
10-statement batch (:390-402) with an isolation fallback that re-runs statements individually and
names failures plus the missing column (:411-440, response :490).

Where it most often breaks or goes silent. (1) Live D1 still lacks the three 2026-09-20 columns, so
the four money fields read null with `health_probe_detail` naming `revenue_cents` (live snapshot
below; applying the migrations is the owner's action, the path is now correct). (2) The human
bottleneck is outside the code: 11 unreviewed, oldest 170.9h (~7.1d), 19 of 27 rows without a brief,
2 planned / 0 running / 0 decided experiments, `vetted_last_7d` 0 — no code change vets a row for
him. (3) Deploy-time: the seed guard fails open and re-seeds on any COUNT failure (Finding 1); the
manual migration loop hides every error as "already applied" (Finding 2). (4) Runtime sources:
unauthenticated Reddit search (`index.js:82-84`) is 429-prone, but `src_fail` accounting (:235, :527)
already degrades that honestly into the research log.

## 3. Health signals measured here

- `npm test` (this session, repo root): exit 0. TAP head shows green suites including the round-4
  additions (`CI applies sorted d1/migrate-*.sql`, 3 tests; `old-schema migration convergence`, 2
  tests with positive control). Compact re-run (`node --test --test-reporter=dot`, same 6 files):
  exit 0, 360/360 completion marks, zero failures — matching the committed Windows baseline
  (`_night/tests-baseline.log`: `ℹ tests 267, suites 93, pass 267, fail 0`, 267+93=360).
- `node --check public/app.js`: exit 0. The ESM sources (`functions/api/[[path]].js`,
  `worker/src/index.js`, `worker/src/lib.js`) are imported live by the suite — a syntax error would
  fail every suite that touches them. `sh -n` on the three shell scripts could not run (sandbox
  approval denied `sh` invocations — blocker, see below); all three were instead reviewed by
  full-file reads (`deploy.sh` 61 lines, `verify.sh` 63, `stamp-release.sh` 8).
- `python3 -m compileall`: not applicable — zero `.py` files (full recursive listing plus a
  `**/*.py` search with no matches; control: the same glob search lists the 3 `*.test.*` files under
  `d1/` and `public/`, and `ls -R` shows the JS/SQL/sh-only tree).
- TODO density: 0 matches for `TODO|FIXME|XXX|HACK` across `public functions worker deploy scripts
  d1`. Dead code: none found. Live near-duplication: the brief-write pass ×2 (Finding 6) plus two
  documented mirrors (`centsDollars` in `[[path]].js:24` ↔ dashboard money render, noted at
  `[[path]].js:23`; local `clamp10` in `[[path]].js:16-20` vs `worker/src/lib.js:4` with a different
  signature).
- Sizes (measured): app.js 1361, `[[path]].js` 520, api.test.mjs 1463, worker index.js 605, lib.js
  77, index.html 121, styles.css 215, schema.sql 102, seed.sql 71, deploy.sh 61, verify.sh 63,
  deploy-worker.yml 57, migrations.test.mjs 126. `public/favicon.svg` is one short line (a few
  hundred bytes, far under the 2 KB limit — also enforced by the green tab-icon suite).
- Surface rules: COMPLIANT, no finding. Served HTML carries icon + `theme-color`
  (`public/index.html:9-10`), inline brand mark (:16), neutral `…` placeholders (:23, :52);
  `styles.css:4` declares `color-scheme: light` with no dark branch; the served snapshot
  (`_night/live/aimoney_pages_dev.html`, 121 lines) is line-identical to `public/index.html`. Live
  health (rev `8d9b974` = HEAD, `2026-09-21T03:17:26Z`): `ok:true, db:up`, 27 opportunities, 11
  unreviewed, 19 bare, `{planned:2}`, `hours_since_last_ok_run:3.3`, `oldest_unreviewed_age_h:170.9`,
  all four money fields null with `health_probe_failures:[decisions_revenue_week,revenue_lifetime]`
  and `health_probe_detail` naming `revenue_cents` twice — isolation + column detail both live.
- Tree state: HEAD `8d9b974` (round 4) equals the live `rev`, so no stale-deploy lag at snapshot
  time. `git status --short` lists 34 modified files but `git diff --ignore-cr-at-eol --stat` is
  empty and `file(1)` reports CRLF on 4/4 sampled worktree files — the entire diff is line endings
  (HEAD is LF). First-five-seconds: strip above the toolbar (`index.html:42`, `app.js:103`),
  mobile compaction (`styles.css:210-215`), last-good paint (`app.js:1193-1242`) — all present and
  test-pinned, no finding.
- Positive controls (absences claimed above): the TODO/dark-pattern searches use the same tool that
  returned 5 hits for `UNREVIEWED` in `worker/src/lib.js`, 6 hits for `color-scheme` (incl.
  `styles.css:4` and the guard tests), and 20+ hits for `experiments_by_status` — so zero means
  absent, not a broken matcher. The suite executed a non-zero denominator (267 tests + 93 suites,
  0 skipped in baseline; 360/360 dots here), so "all green" is a measurement, not an empty pass.
  The convergence suite's withhold-one-migration control fails as required (it ran green, and its
  assertion fails the run if any withheld file still converges).
- Blockers (honest, no workaround attempted beyond one retry): `sh -n <script>` denied twice by
  sandbox approval (`approval aborted`); executing a summary probe from `/tmp` likewise denied, so
  the TAP tail was re-observed via the in-workspace dot-reporter run instead. No network, no
  `--remote` D1, no secret access was attempted.

## 4. Ranked findings (max 8)

Money-first answers, in this project's own numbers, before any task. Earned to date: none recorded
— live health shows `experiments_by_status:{"planned":2}` with zero `won`/`lost` ever, and
`revenue_total` is null (unknown while the probes fail — 0 is not claimed). Last krone arrived:
never. This project is a tool the owner uses, not a product he sells, so findings rank by
owner-time saved and decisions unblocked. Single step to the next payment: a human closes one
experiment `won` with `revenue_cents > 0` and a source (the $0 spec-ad sprint on
`ai-ugc-ads-service`, `d1/seed.sql:67-71`, is the named first candidate). Measured conversion at that
step: 0 decisions from 2 planned (0%); `vetted_last_7d` is 0 for the fourth straight snapshot. The
bottleneck is outside the code (section 2, item 2) — one line, as directed. Surface-rule findings
would rank here but there are none (section 3).

1. **The seed guard fails open: any COUNT failure re-seeds live D1.**
   Evidence: `deploy/deploy.sh:39-41` —
   `COUNT="$($WRANGLER d1 execute aimoney --remote --json --command "SELECT COUNT(*) ..." |
   python3 -c "..." 2>/dev/null || echo 0)"`, then `:42 if [ "${COUNT:-0}" = "0" ]` applies
   `d1/seed.sql`, whose three INSERTs are plain (no `OR IGNORE`: `d1/seed.sql:5,20,67`). A missing
   python3, a changed JSON shape, or any query error prints 0 and seeds a live table: the
   opportunities INSERT fails on slug conflict while the briefs INSERT (SELECT-subselect ids,
   `:20-64`) and the starter-experiment INSERT (`:67-71`) can still land as duplicates — or, since
   the seed step has no tolerance under `set -eu`, the deploy aborts mid-way with Pages/worker
   undeployed. Either branch is wrong, and `2>/dev/null` hides which.
   Why it costs: the only remaining check in the deploy chain that reports success by measuring
   nothing; one bad run corrupts live D1 (duplicate briefs/experiments) or ships half a deploy.
   Fix: fail closed — drop `|| echo 0`, abort with a named error when COUNT is empty/unreadable;
   and make the seed re-runnable (`INSERT OR IGNORE` on opportunities by slug, existence guards on
   the briefs/experiment inserts). Files: `deploy/deploy.sh`, `d1/seed.sql`. Size S. Risk: low.
2. **`deploy.sh` still calls EVERY migration failure "already applied", and has drifted from CI.**
   Evidence: `deploy/deploy.sh:34-38` —
   `$WRANGLER d1 execute aimoney --file="$f" --remote || echo "==> D1: $f already applied
   (continuing)"` — versus `.github/workflows/deploy-worker.yml:38-49`, which tolerates only
   `duplicate column`/`already exists` (case-insensitive) and `exit 1`s otherwise. The comment at
   `deploy-worker.yml:31-32` ("Mirror of the deploy/deploy.sh D1 migration loop") is now false:
   the two paths already disagree, because they are mirrored text, not one list.
   Why it costs: a broken migration on the manual path prints success and the rollout stays green;
   schema drift goes silent exactly where the money-column outage hid for three rounds.
   Fix: give both paths one list — extract the tolerate-list loop into `deploy/migrate.sh` called
   by `deploy.sh` and (after checkout) by the workflow, or at minimum paste the CI case-statement
   verbatim into `deploy.sh` and correct the mirror comment. Second runs must stay clean no-ops.
   Files: `deploy/deploy.sh` (plus `deploy/migrate.sh` / `.github/workflows/deploy-worker.yml` if
   shared). Size S. Risk: low.
3. **`verify.sh` prints the live revision but never checks it — the placeholder passes.**
   Evidence: `deploy/verify.sh:31` greps only `'"project":"aimoney"'`, which the committed
   placeholder `public/release.json:1`
   (`{"project":"aimoney","revision":"dev-undeployed",...}`) also contains; `:39-40` fetch
   `/release.json` and `echo "==> live revision: ${REV}"` with no comparison to the deployed
   commit, no JSON-parse requirement, no HTML-body rejection, no retry, and no expected-SHA input.
   (No second source of truth is needed: `release.json` + health `rev` already exist.)
   Why it costs: a stale edge, a queued build, or a skipped stamp step looks identical to a
   successful deploy — this is the fleet-wide "surface cannot prove what it serves" gap, applying
   here by verification, not by missing file.
   Fix: pass the expected short SHA into `verify.sh` (default `git rev-parse --short HEAD`), fetch
   `/release.json?cb=<ts>`, require JSON parse plus `revision == expected`, retry a stale revision
   a bounded number of times, fail immediately on an HTML body or a wrong revision. Files:
   `deploy/verify.sh` (document the dashboard build-command string alongside). Size S. Risk: low.
4. **`experiments_by_status` still has no probe-failure guard: dead probe 3 reports `{}`.**
   Evidence: `functions/api/[[path]].js:480-481` build the object unconditionally and `:490` guards
   probes 0,1,2,5,6,7,8,9 with `probeFailed(i)` but never probe 3 — `{}` is byte-identical to the
   genuine empty state. (No dashboard consumer today — zero `experiments_by_status` matches in
   `public/app.js` — so this is an API-honesty wart, not a live wrong number; the outage test at
   `functions/api/api.test.mjs:1223` pins the `{}` contract and would need updating with the fix.)
   Why it costs: the one hole left in the unknown-not-zero contract; any future consumer renders a
   phantom "no experiments", the exact wrong-number-instead-of-unknown the money directive bans.
   Fix: emit `probeFailed(3) ? null : experiments_by_status`, add a probe-3 failure case to the
   isolation suite (other nine report, `db` stays `up`, probe named), and keep the healthy payload
   byte-identical. Files: `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Size S.
   Risk: low.
5. **The whole tree diffs on line endings; CRLF shebangs break `./` on Linux.**
   Evidence: `git status --short` lists 34 modified files while `git diff --ignore-cr-at-eol
   --stat` is empty; `file(1)` reports CRLF on 4/4 sampled worktree files; `deploy/deploy.sh:1`,
   `deploy/verify.sh:1`, `scripts/stamp-release.sh:1` carry CR after `#!/usr/bin/env sh`. Same
   family as tonight's `export→port` mangling from an LF pattern in a CRLF file.
   Why it costs: `git status` acceptance is unreadable, every future edit risks off-by-CR
   replacement bugs, and the scripts cannot run via `./` on Linux as-is.
   Fix (owner decision, not this lane): add `.gitattributes` (`* text=auto`, `*.sh eol=lf`) plus
   one normalization commit kept lone; until then, match each file's actual endings and prefer
   whole-line replacements. Files: `.gitattributes` (new), one-time normalization. Size S
   (config) / M (normalize). Risk: medium for the normalization (touches every file).
6. **The worker's brief-write pass is duplicated (~30 lines × 2) and will drift.**
   Evidence: `worker/src/index.js:435-468` (first brief: prompt, parse, empty-brief guard :457,
   `INSERT INTO briefs` :458-466) vs `:491-521` (extra brief: same shape, guard :510, INSERT
   :511-519) — prompt text, guards, and bind order maintained in two places.
   Why it costs: the next prompt/guard/schema fix lands in one copy and silently misses the other;
   with briefs the scarcest output (19 of 27 rows bare), a half-applied brief fix directly taxes
   the review queue that feeds vet→experiment.
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
  and the `.gitattributes` normalization in Finding 5 (owner decision; lone commit).

## 6. Proposed next tasks (2–4)

1. `Seed guard fails closed and seed.sql re-runs cleanly` (52 chars). Owned files:
   `deploy/deploy.sh`, `d1/seed.sql`. Acceptance: when the COUNT query fails or returns nothing,
   the deploy aborts before the seed step with a named error (never seeds on a failed
   measurement); re-running the seed against a non-empty table is a clean no-op; first deploy
   against an empty table still seeds all 12 rows + 4 briefs + starter experiment; all tests green.
2. `deploy.sh shares the CI migration tolerate-list verbatim` (55 chars). Owned files:
   `deploy/deploy.sh` (optionally a shared `deploy/migrate.sh` also called by
   `.github/workflows/deploy-worker.yml`). Acceptance: both paths apply `schema.sql` then every
   `d1/migrate-*.sql` in sorted order from one list; a re-run exits 0; a deliberately broken
   migration exits non-zero with the driver error surfaced (not "already applied"); report the
   exact file:line changed. No `--remote` execution from the lane.
3. `verify.sh requires live revision to equal the deployed commit` (59 chars). Owned files:
   `deploy/verify.sh`. Acceptance: takes an expected SHA (default: current short HEAD); requires
   the body to parse as JSON with `revision == expected`; retries a stale revision a bounded
   number of times; fails immediately on an HTML body, an unparsable body, or the
   `dev-undeployed` placeholder; all existing marker checks behave as today.
4. `health emits null experiments_by_status when probe 3 fails` (55 chars). Owned files:
   `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Acceptance: a probe-3 failure
   yields `experiments_by_status:null` named in `health_probe_failures` while the other nine
   probes report and `db` reads `up`; the healthy payload stays byte-identical (key order
   included); the outage contract test is updated; full suite green.
