# AUDIT-2026-09-20-round3 — aimoney (read-only lane)

Scope note: delegated path `/mnt/c/coding-projects/_workspace/trackb-aimoney-r3` resolves in this
session to `/root/coding-projects/_workspace/trackb-aimoney-r3`; all work was done there. No git
writes, no network, no installs, no edits to existing files, no `.env`/secret reads. No
repo-local `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING` exists (root listing verified); `README.md` was
read first. This file is the only file created. It uses LF to match the committed (HEAD)
convention; the worktree checkout itself is CRLF (Finding 8).

## 1. What this project is and how it runs

- Purpose: AIMoney Lab, a personal tool the owner uses (not a product he sells) — a scored ledger of AI-money opportunities, research briefs, and an experiment tracker that kills/scales ideas on evidence.
- Entry points: static dashboard (`public/index.html`, `public/app.js`, 1361 lines); Pages Functions REST API (`functions/api/[[path]].js`, 520 lines); research Worker (`worker/src/index.js`, 614 lines; shared `worker/src/lib.js`, 77 lines).
- Live surfaces: `https://aimoney.pages.dev/` (dashboard), `https://aimoney.pages.dev/api/health` (JSON), research worker `https://aimoney-research.levitinvlad.workers.dev/`; one D1 database `aimoney` bound as `DB` (`wrangler.toml:13-16`, `worker/wrangler.toml:11-14`).
- Scheduled jobs: Worker cron `0 */6 * * *` (`worker/wrangler.toml:9`) → collect signals → AI triage → brief bare rows (`worker/src/index.js:196-542`); manual triage-only `POST /run` (202, `briefs_skipped:true`, `:601-610`); no other schedulers.
- Deploys: Pages Git-connected build (`scripts/stamp-release.sh` stamps `public/release.json` from `CF_PAGES_COMMIT_SHA`) plus research worker via CI (`.github/workflows/deploy-worker.yml`) or `./deploy/deploy.sh` (D1 schema + shared migrations → seed guard → Pages → worker), verified by `./deploy/verify.sh` (markers + live-revision gate).

## 2. End-to-end walk-through

Main flow A — signal → proposal → brief (all in `worker/src/index.js` unless noted). Cron fires
`scheduled` (:545) → `runResearch(env,"cron")` (:196): reaps stuck runs (:200-205), opens an
`agent_runs` row (:206-215), collects HN/Reddit/GitHub in parallel (`hnSignals` :48, `redditSignals`
:77, `githubSignals` :105 via `timedJson` :36; `Promise.allSettled` :231; per-source failure named in
`src_fail` :73/:101/:236). Signals batch-insert (:242-246), one heartbeat (:248-251), >30d
unprocessed swept to noise (:255-260), oldest-first take of 6 (:262-264), exact-URL supports
pre-pass with no AI call (:270-296), one Mistral classify call (:307-328, `aiComplete` :135,
`parseJsonLines` in `worker/src/lib.js:62`). Validated verdicts (:348-416): `new` INSERTs a
`researching` row with `UNREVIEWED` + capped score (:364-403, at most 2/run via `MAX_NEW_PER_RUN`
:16, dropped to 1 while bare-without-brief exceeds 10 via `BARE_BACKLOG_CAP` :17/:336-340; slug
collision links as supports :395-399); `supports` appends a notes line (:404-412); `noise` just
marks processed (:413-415); verdict writes flush as one `env.DB.batch` (:417). Cron then briefs one
bare row (:419-478, INSERT :467-475) plus one extra oldest-unreviewed row past 48h (:485-533), and
finishes the run log once (:536). Manual path `POST /run` (:601-610) runs collect+triage only and
always skips briefs (:229).

Main flow B — review → vet → experiment → decision. Dashboard `refresh()` (`public/app.js:1304`)
loads `/api/opportunities` (`functions/api/[[path]].js:499` → `listOpportunities` :44-86, capped
scores, `needs_review` bit, brief excerpts) and `/api/health`; the Start-here strip paints the #1
actionable pick with Vet/Kill (`renderStartHere`, `public/app.js:103-133`); the review chip lists
UNREVIEWED oldest-first (`refreshReview`, `public/app.js:242`). Vet (`public/app.js:406`) / Kill
(:487) PATCH `updateOpportunity` (`[[path]].js:138-179`); Start (`public/app.js:582`) PATCHes
`updateExperiment` (`[[path]].js:306-359`), whose closure gate requires `result` + `post_mortem` for
`won`/`lost`, stamps `ended_at`, and appends a one-line `$X rev / $Y spent` outcome to the parent
notes (:339-348). Health (`[[path]].js:374-491`) answers from one 10-statement batch (:402) with an
isolation fallback that re-runs statements individually and names the failing probe plus the missing
column/table (:411-440, response :490).

Where it most often breaks or goes silent. (1) Live D1 still lacks the three 2026-09-20 columns, so
health probes 5–6 fail and the four money fields read null (Finding 1; live snapshot in §3). The
deployed-schema path is now correct (shared sorted migrations in CI and `deploy.sh`), but no
credentialed run has happened yet, so nothing has converged. (2) The human bottleneck, outside the
code: 11 unreviewed, oldest 171.7h (~7.2d), 19 of 27 rows without a brief, 2 planned / 0 running / 0
decided experiments, `vetted_last_7d` 0 — the queue drains only at the bottom. (3) Quiet-tick
sources: unauthenticated Reddit search (`index.js:83-85`) is 429-prone; it already degrades honestly
(6s timeout :19/:36-46, per-query catch, `src_fail` naming), visible solely in the research log.
(4) The stall nudge that would push the one lane-metric action is silently disabled by the same null
probes (Finding 2).

## 3. Health signals measured here

- `npm test` (this session, repo root): exit 0 — `tests 284, suites 97, pass 284, fail 0,
  cancelled 0, skipped 0, todo 0, duration_ms 2012.946823`. Counts match
  `_night/tests-baseline.log` exactly (284/97/0 there too, `duration_ms 353.4872` on Windows;
  slower here under the sandbox proxy, same verdict). Includes the probe-isolation suite (6 tests:
  nine report + named, column-only detail, table-only detail, byte-identical keys, db-up-on-count-fail, spurious-reject attaches nothing).
- `node --check public/app.js`: exit 0. The three ESM sources (`functions/api/[[path]].js`,
  `worker/src/index.js`, `worker/src/lib.js`) are imported live by the suite — any syntax error
  would fail every suite that touches them.
- `python3 -m compileall`: not applicable — zero `.py` files; the repo is JS/SQL/sh-only (verified
  by full directory listings of `public functions worker d1 deploy scripts docs .github`).
- TODO density: 0 matches for `TODO|FIXME|XXX|HACK|console\.log` in shipped source (regex mode;
  the only matches repo-wide are prior audits in `docs/audits/` discussing the metric itself).
  Positive controls: the same regex tool matches `UNREVIEWED` in shipped source (`public/app.js`
  ×6, e.g. :237/:240/:403/:774), `color-scheme` hits `public/styles.css:4`, and the suite executed
  284 tests with 0 skipped — so zeros are absence, not a dead matcher (an earlier literal-mode pass
  with `|` unescaped returned empty and was discarded as the match-nothing trap, re-run in regex mode).
- Dead code: none found. Every worker helper is called (`timedJson` by the 3 collectors,
  collectors + `aiComplete` by `runResearch`, `runResearch` by `scheduled` + `POST /run`);
  `moneyCents` (`public/app.js:53`) has 5 call sites; the `substr(notes || ?, -8000)` idiom has 5
  live writers (API :300/:346, worker :292/:399/:409). Duplicated logic: the brief-write pass
  (~35 lines × 2, Finding 7); local `clamp10` in `[[path]].js:16-20` vs `worker/src/lib.js:4-7`
  (different signatures); `centsDollars` (`[[path]].js:24`) ↔ `moneyCents` (`public/app.js:53`,
  documented mirror at `[[path]].js:23`).
- Sizes (`wc -l`): app.js 1361, index.js 614, index.html 121, styles.css 215, lib.js 77, schema.sql
  102, seed.sql 105. `ls -l public`: favicon.svg 285 bytes (< 2 KB), release.json 85 bytes.
- Surface rules: COMPLIANT, no finding. Served HTML carries icon + `theme-color`
  (`public/index.html:9-10`), inline brand mark (:16) reusing the favicon accent/glyph, neutral
  `…` placeholders (:23, :52); `styles.css:4` declares `color-scheme: light` with no dark branch
  (only other `@media` are reduced-motion :207 and mobile :210); the guard suites (`tab-icon`, 5
  tests) are green. Live HTML snapshot is byte-identical to the repo file (both 5516 bytes served).
- First-five-seconds judgment: the strip exists and paints from the last-good cache before first
  fetch (`public/app.js:103-133`, `:1204-1224`), and the mobile masthead compacts
  (`styles.css:210-215`). The gap is Finding 2: with money probes failing, the Experiments header
  degrades to bare counts with no week line and no nudge.
- Build identity: this surface already publishes a commit — `/release.json` (not `/build.json`),
  stamped by `scripts/stamp-release.sh:5-8` (Pages build) and `deploy/deploy.sh:58`, carrying
  `revision` + `built_at`; `deploy/verify.sh:45-79` fetches it cache-busted, requires JSON parse +
  `revision == expected`, retries stale ×6, and fails immediately on HTML/unparsable/placeholder
  bodies. No second source of truth is needed. The live `/release.json` body was NOT measured this
  run (no saved snapshot, no network) — stated plainly, not assumed. The committed placeholder
  (`public/release.json:1`, `dev-undeployed`) is by design (overwritten at build; `verify.sh:67-68`
  fails if it ever serves).
- Live snapshot `_night/live/aimoney_pages_dev_api_health.html` (rev `c0a1e58`,
  2026-09-21T04:00:36Z): `db:up`, 27 opportunities, 11 unreviewed, 19 bare, `planned:2`, 4h since
  last ok run, oldest unreviewed 171.7h, four money fields null, `vetted_last_7d:0`,
  `vetted_no_experiment:0`, `noise_24h:0`, failures `[decisions_revenue_week, revenue_lifetime]`
  with detail `revenue_cents` on both. Isolation + column naming are live and working.
- Tree state: `git status --short` lists 35 modified files but `git diff --ignore-cr-at-eol --stat`
  is empty and `file deploy/deploy.sh` reports CRLF — the entire diff is line endings (HEAD is LF;
  Finding 8). Log HEAD: `612287b` (round 2, 2026-09-21 06:00 +0200); live `rev` is `c0a1e58`
  (round 1) — one commit behind, but the snapshot (04:00:36Z) coincides with the HEAD commit
  (04:00:28Z), so no stale deploy is proven.

## 4. Ranked findings (max 8)

Ranking basis is the lane metric (experiment decisions/week, vetted→experiment conversion,
unreviewed backlog drained) under the money-first directive; surface-rule findings would rank here
but there are none (see §3). Human-bottleneck mapping: sub-minute phone clear → Finding 2 is the
remaining gap (strip + review decision lines already exist); reversible worker decisions → already
present (inflow caps, supports-linking, noise sweep — nothing further proposed unprompted); a
zero-spend experiment → already named (the $0 spec-ad sprint, `d1/seed.sql:96-105`, one-tap Start);
real money on close → blocked only by Finding 1.

1. **The self-migration switch does not exist; live D1 still lacks 3 columns and 4 money fields are null.**
   Evidence: live `/api/health` at rev `c0a1e58` reads `"decisions_last_7d":null,
   "revenue_last_7d":null, "revenue_total":null, "spent_total":null,
   "health_probe_failures":["decisions_revenue_week","revenue_lifetime"]` with detail
   `revenue_cents` — exactly the two probes that `SUM(revenue_cents)`/`SUM(spent_cents)`
   (`functions/api/[[path]].js:396-397`). Zero matches for `ALLOW_SCHEMA_MIGRATION` or
   `PRAGMA table_info` anywhere in shipped code, and the health response (`[[path]].js:490`)
   carries no "migration available but disabled" line. The deploy path is now correct (CI
   `.github/workflows/deploy-worker.yml:27-37` runs schema then the shared sorted
   `deploy/apply-d1-migrations.sh`, same as `deploy.sh:33-37`), but the repository has no
   Cloudflare credentials, so no credentialed run has ever converged the live table.
   Why it costs: the lane metric (decisions/week) and every money figure are unreadable; worse, the
   null `decisions_last_7d` also disables the stall nudge (`public/app.js:665` requires `=== 0`),
   so the one push toward the next decision is off exactly when the stall is total.
   Fix: implement exactly the specified shape — on first need, `PRAGMA table_info(experiments)`
   compared ONLY against the columns the probes read; if missing AND `ALLOW_SCHEMA_MIGRATION=1`,
   apply exactly the `ALTER TABLE ADD COLUMN` statements from
   `d1/migrate-2026-09-20-experiment-cents.sql` with their defaults, one at a time; if unset,
   change nothing and report the missing columns plus the disabled line in the health payload; run
   at most once per isolate with a clean no-op second run; ADD only, no endpoint. Files:
   `functions/api/[[path]].js`, `functions/api/api.test.mjs` (old-schema table + var set ⇒ all
   probed columns; var unset ⇒ unchanged + named; twice ⇒ no-op). Size M. Risk: medium (writes to
   live D1; contained by default-off + additive-with-default + no trigger besides the variable).

2. **Stall nudge + week line die on null probes though `/api/experiments` already in memory could answer.**
   Evidence: `public/app.js:655` requires `decisions !== null && vetted !== null` before the
   conversion line renders, and `:665` fires the nudge only on `decisions === 0` — live `null`
   yields neither, so the Experiments tab shows just `2 experiments · 0 running · 0 won` with no
   week line and no nudge, hiding the most important truth (zero decisions, stalest card aging)
   behind the same outage.
   Why it costs: first-five-seconds failure on the one tab that moves the lane metric; the owner
   sees bare counts instead of the next action.
   Fix: derive nudge eligibility (and a fallback decisions count) from `state.experiments` —
   `won`/`lost` with `ended_at` in 7d, already fetched, no new request — while health numbers win
   whenever present; pin with a dashboard test (null health + stalest planned card ⇒ nudge with
   Start). Files: `public/app.js`, `public/dashboard.test.mjs`. Size S. Risk: low.

3. **Worker `GET /` reports `ok:true` when D1 is unreachable.**
   Evidence: `worker/src/index.js:550-554` — the last-run read `.catch(() => null)`s, then the
   handler returns `json({ ok: true, agent: "research-v1", last_run: last })` regardless, so a dead
   database serves `{ok:true, last_run:null}`. Contrast the API, which flips `ok:false` on total
   outage (`[[path]].js:445,490`). `deploy/verify.sh:39` greps only the agent marker, so a dead
   worker DB passes verification too.
   Why it costs: reliability-angle lie — the overnight step most likely to break unattended (a D1
   outage) reads as healthy on the worker surface and in the rollout gate.
   Fix: return `ok:false` (503) when the last-run read fails or `DB` is missing; extend the
   `worker-status` verify check to require `"ok":true`; add a worker test pinning both shapes.
   Files: `worker/src/index.js`, `worker/src/index.test.js`, `deploy/verify.sh`. Size S. Risk: low.

4. **`updateExperiment` PATCH has no string bounds; create and `updateOpportunity` do (F7 gap).**
   Evidence: `[[path]].js:313-316` assigns `next[f] = String(b[f])` unbounded for
   name/hypothesis/budget_cap/spent/metric/target/result/started_at/ended_at/post_mortem, while
   `createExperiment` slices the same fields (`:287-292`: 200/8000/120/120/300/300/8000/30/30/8000)
   and `updateOpportunity` enforces the identical table with the comment "an unbounded PATCH must
   not write past the newest-kept idiom every other writer honors" (`:145-152`).
   Why it costs: unbounded writes bloat long-lived columns and admit oversized payloads through the
   one writer the F7 pass missed.
   Fix: mirror create's slice table in `updateExperiment`; add the API parity test (oversized PATCH
   truncates exactly like create). Files: `functions/api/[[path]].js`,
   `functions/api/api.test.mjs`. Size S. Risk: low.

5. **`experiments_by_status` is still unguarded on probe-3 failure — and nothing in the dashboard reads it.**
   Evidence: `[[path]].js:480-482` build the map unconditionally and `:490` emits it with no
   `probeFailed(3)` guard (every other fallible probe is guarded); a dead probe 3 reports `{}`
   ("no experiments"). Zero matches for `experiments_by_status` in `public/` — the key is produced
   for no in-repo consumer (only asserted in `functions/api/api.test.mjs:1280,1359`).
   Why it costs: a public key that either fabricates "zero experiments" on outage (the wrong-number
   the money directive bans) or is dead surface nobody maintains.
   Fix: emit `probeFailed(3) ? null : experiments_by_status` plus an isolation-test case — or remove
   the key and its assertions if no consumer exists. Files: `functions/api/[[path]].js`,
   `functions/api/api.test.mjs`. Size S. Risk: low.

6. **Exact-URL pre-pass does up to 12 sequential D1 writes inside the 30s wall-clock budget.**
   Evidence: `worker/src/index.js:287-293` awaits a signals UPDATE plus an opportunities UPDATE per
   exact-URL hit, up to 6 signals in a `for` loop — while the verdict loop batches the identical
   write shape into one `env.DB.batch` (`:417`) after the collect phase proved batching cuts ~9s to
   ~0.5s (`:240-241`).
   Why it costs: a 6-hit pre-pass burns up to 12 sequential round trips on the manual path that
   shares waitUntil's proven 30s cap (`:7-11`); the reliability angle says the most breakable
   unattended step is wall-clock exhaustion.
   Fix: push each hit's two UPDATEs into an array flushed with one `env.DB.batch` (keeping the
   `.catch(() => null)` on the notes append); existing pre-pass tests should pass unchanged. Files:
   `worker/src/index.js`. Size S. Risk: low.

7. **The worker's brief-write pass is still duplicated (~35 lines × 2) and will drift.**
   Evidence: `worker/src/index.js:444-478` (first brief: signal fetch, prompt, parse, empty-brief
   guard :466, `INSERT INTO briefs` :467-475) vs `:500-530` (extra brief: same shape, guard :519,
   INSERT :520-528) — prompt text, guards, and bind order maintained in two places (unchanged since
   the round-4 audit).
   Why it costs: the next prompt/guard/schema fix lands in one copy and silently misses the other;
   with briefs the scarcest output (19 of 27 rows bare), a half-applied brief fix directly slows
   the review queue.
   Fix: extract one `briefOne(env, state, target, sigs, retries)` helper (keeping `retries:1` vs
   `retries:0` as a parameter and the distinct bare/extra-bare selection queries at the call
   sites); existing worker tests should pass unchanged. Files: `worker/src/index.js`. Size S.
   Risk: low.

8. **The whole tree diffs on line endings; CRLF shebangs break `./` on Linux; no `.gitattributes`.**
   Evidence: `git status --short` lists 35 modified files while `git diff --ignore-cr-at-eol --stat`
   is empty; `file deploy/deploy.sh` reports `with CRLF line terminators`; root listing shows no
   `.gitattributes`. `deploy/deploy.sh:1`, `deploy/verify.sh:1`, `scripts/stamp-release.sh:1` carry
   CR after `#!/usr/bin/env sh`, which fails direct execution on Linux. Same family as the
   overnight `export→port` mangling the brief cites.
   Why it costs: `git status` acceptance is unreadable, every future edit risks off-by-CR
   replacement bugs, and the deploy scripts cannot run via `./` on Linux CI as-is.
   Fix (owner decision, not this lane): add `.gitattributes` (`* text=auto`, `*.sh eol=lf`) plus
   one normalization commit; until then, match each file's actual endings and prefer whole-line
   replacements. Files: `.gitattributes` (new), one-time normalization. Size S (config) / M
   (normalize). Risk: medium for the normalization (touches every file; keep it a lone commit).

## 5. What NOT to change

- Credentials and remote writes. The repo has no `CF_API_TOKEN`/`CF_ACCOUNT_ID`; adding them to
  this repository's secrets is the owner's action — never create, enter, print, or store a
  credential. Likewise never run `wrangler d1 execute --remote`, a migration, or any write against
  production D1 from an audit/implementation lane; applying the pending migrations to live D1 is
  the owner's action (Finding 1 only builds the switch he flips). `ADMIN_TOKEN` rotation stays
  manual per `README.md:85-88`.
- The human-owned review boundary. `worker/src/index.js:4-5`: "The agent PROPOSES; the human owns
  the testing workflow (it never moves status to testing/scaling/killed)." Vet/Kill/vetted-tag,
  `researching → testing`, and every close decision stay human taps; never auto-transition status,
  never mark an experiment decided without evidence, never invent a revenue figure.
- Deliberate board semantics. `README.md:64`: "Killed strategies stay on the board with their
  post-mortem — that is the point." Score formula `score = 100 * (value * confidence * fit) /
  (effort + 1)`, the `UNREVIEWED` ≤6000 cap (`worker/src/lib.js:21-32`), inflow cap 2/run
  (`worker/src/index.js:16`) with the bare-backlog drop to 1 (`:17`), `MAX_AI_CALLS = 4` (:18),
  manual brief-skip (:229, :601-610), and the <30s `waitUntil` budget (:7-11) are all documented
  load-bearing rails — tune only with owner sign-off and a test pinning the new bound.
- Anything needing a login, payment, or platform permission: Reddit/GitHub/HN terms (no scraping or
  messaging a platform forbids), Cloudflare dashboard settings (Pages build command, env vars),
  and the `.gitattributes` normalization in Finding 8 (owner decision; lone commit).

## 6. Proposed next tasks (2–4)

Money-first answers, in this project's own numbers, before any task. Earned to date: none — live
health shows `experiments_by_status:{"planned":2}` with zero `won`/`lost` ever, and the seed ships
one planned $0 experiment (`d1/seed.sql:96-105`); last krone arrived: never. This project is a tool
the owner uses, not a product he sells, so tasks rank by owner-time saved and decisions unblocked.
Single step to the next payment: close one experiment `won` with `revenue_cents > 0` (the $0
spec-ad sprint, `ai-ugc-ads-service`, is the named first candidate); conversion at that step is
unmeasured (zero closures to date). The bottleneck is outside the code: 11 unreviewed (oldest
171.7h), 19 of 27 without a brief, `vetted_last_7d` 0 — no code change vets a row for him.

1. `Worker self-adds missing money columns behind ALLOW_SCHEMA_MIGRATION=1` (69 chars).
   Owned files: `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Acceptance: a table
   built from the old schema plus the check plus the variable set ends with every column the
   probes read; the same table with the variable unset ends unchanged and the health payload names
   the missing columns plus the disabled line; a second run is a clean no-op; ADD-only (no DROP,
   no column ALTER, no rewrite, no DELETE), no migration endpoint, default-off so unset behaviour
   is byte-identical to today. Report the three results and the exact variable name.
2. `Nudge + week line fall back to loaded experiments when probes fail` (62 chars). Owned files:
   `public/app.js`, `public/dashboard.test.mjs`. Acceptance: with `decisions_last_7d:null` and a
   stalest open card, the Experiments header still shows the week line from the loaded list and the
   nudge with its Start button; health numbers win whenever present; all 284 existing tests green.
3. `Worker root reports ok:false when D1 is unreachable` (47 chars). Owned files:
   `worker/src/index.js`, `worker/src/index.test.js`, `deploy/verify.sh`. Acceptance: a failing
   last-run read yields `ok:false` (non-2xx) instead of `ok:true` + `last_run:null`; the
   `worker-status` verify check requires `"ok":true`; healthy shape unchanged.
4. `Bound updateExperiment strings exactly like create` (46 chars). Owned files:
   `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Acceptance: an oversized PATCH
   truncates per create's table (name 200, hypothesis/result/post_mortem 8000, caps 120,
   metric/target 300, stamps 30); closure gate, stamps, and outcome-ledger tests green.
