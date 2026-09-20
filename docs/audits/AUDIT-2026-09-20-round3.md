# AUDIT 2026-09-20 — aimoney (round 3, monetization lane)

Clone HEAD: `6dac871` (round 2). Live rev (`_night/live/aimoney_pages_dev_api_health.html`): `0fb4fb2` (round 1).
Lane metric right now (live payload): **0 decisions/week, 0 vetted/week, 11 unreviewed (oldest 155.6h ≈ 6.5d),
19/27 rows without a brief, 2 planned / 0 running experiments, revenue unmeasured** (no `revenue_last_7d` key live).
No repo-local `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING.md` exists; governed by `README.md` plus the standing rules.
Surfaces judgment: live and repo HTML are identical and compliant — light palette only
(`public/styles.css:4` `color-scheme: light`, no dark branch found by search), favicon + `theme-color`
(`public/index.html:9-10`, `public/favicon.svg` 285 bytes), inline brand mark (`public/index.html:16`),
guard test green (`public/tab-icon.test.mjs`). **Zero surface-rule findings this round.**

## 1. What this project is and how it runs

- Purpose: AIMoney Lab — a ranked board of AI-money opportunities with evidence briefs and experiments (`README.md:1-15`).
- Entry points: dashboard `public/app.js` + `public/index.html`; API `functions/api/[[path]].js`; agent `worker/src/index.js`.
- Live surfaces: `https://aimoney.pages.dev`, `/api/health`, research worker (`README.md:27-31`).
- Scheduled jobs: worker cron every 6h (`worker/wrangler.toml:8-9`); manual triage-only `POST /run` (`worker/src/index.js:460-469`).
- Deploys: `./deploy/deploy.sh` (D1 schema+migrations+seed-if-empty, stamp `release.json`, Pages, worker), `./deploy/verify.sh` gates rollout.

## 2. End-to-end walk-through

1. Collect: cron tick → `runResearch(env,"cron")` (`worker/src/index.js:141`) fans out HN/Reddit/GitHub (`:176`), batch-inserts signals (`:182-186`).
2. Sweep + take: 30d-stale signals → noise (`:195-199`); oldest 6 unprocessed taken (`:201-203`). **Silent exit A:** `if (!fresh.length)` returns `ok` at `:204-207` — before the brief pass.
3. Triage: one Mistral NDJSON pass over top-60 list + fresh signals (`:209-230`); `new` inserts capped `UNREVIEWED` rows (`:251-275`), `supports` appends evidence (`:276-284`), else noise (`:285-287`).
4. Brief: one bare row (top-scored, or oldest-unreviewed past 48h, `:290-308`) + one extra oldest bare row past 48h on cron (`:349-393`); empty/malformed brief JSON is skipped silently (`:343`, `:390`).
5. Serve: `GET /api/opportunities` returns `effectiveScore`-capped rows (`functions/api/[[path]].js:61-64`); health carries queue + money counters (`:343-377`).
6. Vet: human Vet/Kill in review list (`public/app.js:220-256`) or drawer (`:454-456`); vet appends `[date vetted]`, lifts the 6000 cap; kill requires a post-mortem prompt.
7. Test: `researching → testing` by hand; experiment `planned → running → won/lost` with closure rules + cents + outcome ledger (`functions/api/[[path]].js:231-328`); drawer suggests a ±1 rescore, never auto-applied (`public/app.js:474-484`).
8. Where it breaks/goes silent, in order: **(a)** live never got round 2 (rev `0fb4fb2`, no `revenue_last_7d` key) so all money code is local-only; **(b)** quiet ticks exit before briefing (`worker/src/index.js:204-207`) while 19/27 rows stay bare; **(c)** the human vet bottleneck — 11 unreviewed, oldest 155.6h, zero vetted this week; **(d)** orphaned experiment cards dead-end in a toast (`public/app.js:343`).

## 3. Health signals measured here

- `npm test` (this Linux checkout, exit 0): **94 pass / 0 fail, 36 suites, duration_ms 945.1** — same 94/36 as the Windows baseline (`_night/tests-baseline.log`, 225.7ms there; slower here is environment, not regression). Only warnings are the known `MODULE_TYPELESS_PACKAGE_JSON` reparsing notes and sandbox proxy notes.
- `python3 -m compileall`: N/A — repo contains zero `*.py` files (JS-only: Pages + Functions + Worker, `node --test` suites).
- Dead code (all still present, carried): `BRIEF_DEADLINE_MS` never referenced (`worker/src/index.js:20` vs live `:174`); unused `scoreOf` import (`worker/src/index.js:139`, no other use in file); redundant double `await finish("ok")` (`worker/src/index.js:394-395`); `GITHUB_QUERIES.slice(0,2)` silently drops `ai-side-project` (`:115` vs `:27`); `appendKeepNewest` has zero production callers (`worker/src/lib.js:36-39`).
- Duplicated logic: classify prompt text duplicated between the pass (`worker/src/index.js:213-223`) and `/debug-classify` (`:439-448`); brief-insert block duplicated for main (`:333-341`) and extra (`:380-387`) briefs; create-vs-update string bounds differ (see F8).
- TODO density: **0** — search for `TODO|FIXME|HACK|XXX` across `public/`, `functions/`, `worker/src/` returns nothing. No dark-mode markers (`prefers-color-scheme`, `data-theme`, theme toggle) anywhere.

## 4. Ranked findings (max 8)

### F1 — Live is a full round behind: every round-2 money change is local-only

- Evidence: live `_night/live/aimoney_pages_dev_api_health.html` reads `"rev":"0fb4fb2"` with keys `decisions_last_7d, vetted_last_7d, vetted_no_experiment, noise_24h` but **no `revenue_last_7d`**; clone HEAD is `6dac871` ("Implement audit Tasks 2-4", `git log`) whose health emits `revenue_last_7d` (`functions/api/[[path]].js:354,377`). Round 2's audit Task 1 (deploy `0fb4fb2`) evidently landed, but nothing after it did.
- Why it costs money: experiment cents, the revenue sum, Add-modal money fields, and drawer Vet/Kill — the entire "outcome measurable in money" stack — have never touched real data. Live decisions/vetted stay 0 partly because the tools that produce them aren't live.
- Fix: operator run only — `./deploy/deploy.sh` (applies `d1/migrate-2026-09-20-experiment-cents.sql` additively, stamps rev) then `./deploy/verify.sh` including the ≤12h freshness gate. No code edits. Touch nothing in the repo.
- Size S. Risk: low (additive migration defaults 0; seed-if-empty guards live rows, `deploy/deploy.sh:30-47`).

### F2 — `revenue_last_7d` is computed but never displayed; fractional dollars render raw

- Evidence: API computes and tests the sum (`functions/api/[[path]].js:354,377`; `functions/api/api.test.mjs:704-729`) but search for `revenue_last_7d` in `public/` returns **zero lines** — `renderExperiments` (`public/app.js:300-328`) shows decisions/vetted counts only. Meanwhile board cards format cents via `money(e.revenue_cents/100, …)` (`public/app.js:336`) whose formatter (`:43-47`, `` `$${n}` ``) prints e.g. `$10.5` instead of `$10.50`.
- Why it costs money: the one number this lane exists to move — actual revenue pursued — is invisible on the board; when it appears, unrounded figures erode trust in the money display.
- Fix: append `· $X revenue this week` (from `state.health.revenue_last_7d`, hidden when null/undefined for old backends) to the experiments summary string, and format cents as fixed-2dp dollars at the call sites. Add dashboard static tests locking the copy and the formatting. Touch `public/app.js`, `public/dashboard.test.mjs`.
- Size S. Risk: low (read-only header copy; health payload and scoring untouched).

### F3 — The brief pass is unreachable on quiet ticks, so the 19 bare rows never drain

- Evidence: `const fresh = … WHERE processed = 0 …` then `if (!fresh.length) { await finish("ok"); return …; }` (`worker/src/index.js:201-207`) returns **before** the brief pass (`:290-344`) and the extra-brief block (`:349-393`). Live: `bare_without_brief: 19` of 27, `oldest_unreviewed_age_h: 155.6`, while runs stay `ok` every ~6h — consistent with ticks that triage nothing and brief nothing.
- Why it costs money: scores stay evidence-free (19 `no brief` pills), and the Start-here strip's "Next" line falls back to `"No brief yet — open the drawer for facts."` (`public/app.js:96`) instead of a concrete first action. Briefing is gated on fresh-signal presence, which has nothing to do with brief backlog.
- Fix: move the no-fresh-signals early return to after the brief pass (or run the brief section first): still skip the classify AI call when `fresh` is empty, but always attempt the main + extra brief within the existing `MAX_AI_CALLS` budget and cron/manual deadline split. Add a worker test pinning "brief attempted with zero fresh signals". Touch `worker/src/index.js`, `worker/src/index.test.js`.
- Size S. Risk: low-medium (touches the cron path; keep the manual `briefs_skipped:true` contract and AI budget intact).

### F4 — "Start here today" can recommend a killed or paused idea

- Evidence: `const topOpportunity = (opps) => (opps || []).slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;` (`public/app.js:79-81`) — no status filter — and `renderStartHere` (`:89-117`) renders whatever it returns. Killed rows keep their scores and stay on the board by design (`README.md:64`), so killing the #1 seed flips the strip to "start with this dead idea"; same for a deliberately shelved `paused` row.
- Why it costs money: the strip is the lane's "single highest-expected-value opportunity surfaced first". Pointing it at an explicitly rejected row sends today's effort somewhere the owner already ruled out, and teaches distrust of the strip.
- Fix: exclude `killed` and `paused` in `topOpportunity` (keep `scaling` — pushing the winner is legitimate "start here"); when nothing remains the strip already hides (`:93`). Lock with dashboard static tests (killed #1 skipped; all-killed hides strip). Touch `public/app.js`, `public/dashboard.test.mjs`.
- Size S. Risk: low (read-only pick logic; ledger order and scoring untouched).

### F5 — Review queue is static at 11 (oldest 6.5d) with no Priority-side stall nudge

- Evidence: live `unreviewed: 11`, `oldest_unreviewed_age_h: 155.6`, `vetted_last_7d: 0` — identical to the round-2 snapshot, i.e. zero queue movement. The experiments side got a stall nudge (`public/app.js:321-328`, names the stalest open card with a one-click open); the Priority toolbar has only the passive `Needs review (N · oldest …)` chip (`:184-189`) with no equivalent call to action.
- Why it costs money: draining the unreviewed backlog into vetted-then-experimented rows is half the lane metric, and vetting is the human bottleneck. The experiments nudge pattern is proven in-repo; review has no mirror.
- Fix: when `reviewList` is non-empty and `oldest_unreviewed_age_h > 48`, render a one-line read-only nudge in the Priority toolbar naming the oldest row + age with a one-click drawer open (reuse `oldestReviewAge`/`openDrawer`). Static-test the copy and the 48h gate. Touch `public/app.js`, `public/dashboard.test.mjs`.
- Size S. Risk: low (read-only; no auto-vet, no status moves).

### F6 — Experiments header still mixes a 7-day vetted count with an all-time experiment total (round-2 F7, carried)

- Evidence: `vetted` comes from `state.health.vetted_last_7d` (`public/app.js:306`) but renders as `` `${vetted} vetted → ${exps.length} experiments` `` (`:314`) where `exps` is every experiment ever (`:301`). Live it reads `0 vetted → 2 experiments`; after a vetting burst it can exceed 100% "conversion" against rows logged months before the window.
- Why it costs money: this header is the lane-metric readout the owner watches; a conversion fraction with mismatched windows misleads exactly the prioritization call it exists to inform.
- Fix: fold into the F2 header task — label windows honestly in the same string (e.g. `… · 3 vetted this week → 9 total experiments · $X revenue this week`), one line plus the same dashboard static test. Touch `public/app.js`, `public/dashboard.test.mjs`.
- Size S. Risk: low (header copy only).

### F7 — Orphaned experiments still have no remediation path; no DELETE anywhere (round-2 F5, carried)

- Evidence: `LEFT JOIN` keeps dangling rows with `orphaned:true` (`functions/api/[[path]].js:217-228`); the board renders an `orphaned` pill (`public/app.js:336`) but the click dead-ends: `if (c.dataset.orphan === "1") return toast("Orphaned experiment — its opportunity was deleted.");` (`:343`); search for `DELETE` in `functions/api/[[path]].js` returns zero lines, and schema FKs are advisory without `PRAGMA foreign_keys` (`d1/schema.sql:50`).
- Why it costs users/trust: orphans accumulate with no admin action — no delete, no relink, not even a drawer — slowly filling the board with unactionable cards that pollute the experiment counts.
- Fix: admin-only `DELETE /api/experiments/:id` (same `authed` + 404 shape as update) with a `Delete` button on orphaned cards only, behind the token check with a confirm; keep the toast for non-admins. API tests for 401/404/happy-path. Touch `functions/api/[[path]].js`, `public/app.js`, `functions/api/api.test.mjs`.
- Size M. Risk: medium (first DELETE endpoint; restrict to experiments, never cascade).

### F8 — Unbounded update strings + worker auth/dead-code drift (round-2 F6+F8, carried, polish last)

- Evidence: `createOpportunity` slices every string (`functions/api/[[path]].js:87-101`) but `updateOpportunity` stores raw (`:124-128`, `next[f] = String(b[f])`, no slice on any of eight fields); same split on experiments (create `:258-267` vs update `:286-289`). Worker still `!==`-compares tokens in three places (`worker/src/index.js:417,432,463`, collapsing unset-token 503 into 401) vs the API constant-time compare (`functions/api/[[path]].js:21-29`); dead items from §3 all survive.
- Why it costs trust/maintainability: a single `PATCH` with a megabyte `title` passes every guard `POST` enforces (ledger rendering, notes-idiom bloat); the next editor tunes the wrong deadline constant or "fixes" the dropped GitHub query. No direct money movement — ranked last.
- Fix: mirror create-path `slice()` bounds into both update handlers with two truncation tests; extract the constant-time compare into `worker/src/lib.js`, align worker 503/401, delete the redundant first `finish("ok")`, delete-or-wire `BRIEF_DEADLINE_MS`, drop `scoreOf` from the worker import, document `appendKeepNewest` as a test oracle, comment `slice(0,2)`. Touch `functions/api/[[path]].js`, `functions/api/api.test.mjs`, `worker/src/lib.js`, `worker/src/index.js`.
- Size S. Risk: low (`npm test` must stay green; keep tokens out of logs).

## 5. What NOT to change

- Scoring formula: `score = 100 * (value * confidence * fit) / (effort + 1)`, inputs 1–10 (`README.md:56`; `worker/src/lib.js:15-16`). F4/F6 only change which row is picked and how headers read — never the math.
- Human-owns-status: "The agent never moves status." (`README.md:72`); "The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed)." (`worker/src/index.js:4-5`). No auto-transitions, auto-vetting, or auto-scaling — F3/F5 add briefing throughput and a nudge, not decisions.
- Manual-triage-only + briefs-on-cron: "Manual `Run triage now (briefs on cron)` collects and triages only (`POST /run` 202 carries `briefs_skipped:true`); briefs land on cron ticks" (`README.md:77`; `worker/src/index.js:174`). F3 must preserve the manual skip.
- Killed-with-learning: "Killed strategies stay on the board with their post-mortem — that is the point." (`README.md:64`); "Closing an experiment as `won`/`lost` requires `result` + `post_mortem`" (`README.md:74`). F4 hides killed rows from the strip only; F7 deletes orphaned *experiments*, never killed opportunities.
- Capped humility + honest display: proposals "enter as `researching` with an `UNREVIEWED` marker in notes and an effective score capped to ≤6000 until a human vets them" (`README.md:65`); "rows without a brief carry a 'no brief' pill" (`README.md:78`). Vet/kill stay human.
- Never-auto-applied rescore: "offers a suggested ±1 value/confidence rescore the human applies with one click — never auto-applied" (`README.md:74`; `public/app.js:474-484`).
- Read-only warnings: badges "flag status mismatches read-only — the human still owns every status move" (`README.md:79`).
- Seed-vs-live accounting: "Seed runs once on an empty table; live count = 12 seeds + agent proposals + manual adds." (`README.md:83`); deploy's seed-if-empty stays (`deploy/deploy.sh:30-47`).
- Auth split and secrets: "Reads are public. Writes require `Authorization: Bearer <ADMIN_TOKEN>`." (`functions/api/[[path]].js:1-2`); "No expiry; rotate manually when shared or leaked." (`README.md:88`). F1 names the deploy; it does not perform it.
- Anything needing a login, payment, or human judgment: vetting the 11 `UNREVIEWED` rows, `researching → testing → scaling` moves, starting the 2 `planned` experiments, post-mortems, niches/pricing/outreach, token rotation. The most valuable move on the lane metric remains non-code: deploy (F1), then a human vetting the 11 and starting one `planned` experiment.
- Live surfaces already compliant (light palette, favicon + theme-color, brand mark, guard test green) — do not restyle, re-palette, or re-icon.

## 6. Proposed next tasks (2–4)

### Task 1: Show weekly revenue and honest window labels in the Experiments header

- Owned files: `public/app.js`, `public/dashboard.test.mjs`.
- Acceptance: (a) summary appends `· $X revenue this week` from `revenue_last_7d` (hidden when the key is absent, for old backends); (b) vetted/experiment windows labeled (`this week` vs `total`); (c) cents render as fixed-2dp dollars (`$10.50`, never `$10.5`); (d) dashboard static tests lock copy + formatting; (e) `npm test` green; (f) zero-spend, no new accounts, no API/scoring change.

### Task 2: Brief bare rows even when a tick has no fresh signals

- Owned files: `worker/src/index.js`, `worker/src/index.test.js`.
- Acceptance: (a) a run with zero unprocessed signals still attempts the main + extra brief within `MAX_AI_CALLS`; (b) classify AI call still skipped when `fresh` is empty; (c) manual `POST /run` still 202s with `briefs_skipped:true`; (d) worker test pins "brief attempted with zero fresh signals"; (e) `npm test` green; (f) no migration, no status moves, no auto-vet.

### Task 3: Start-here strip skips killed and paused rows

- Owned files: `public/app.js`, `public/dashboard.test.mjs`.
- Acceptance: (a) a killed or paused #1-by-score row is skipped in favor of the next actionable row; (b) `scaling` rows remain eligible; (c) strip hides when nothing actionable remains; (d) dashboard static tests cover killed-skipped, paused-skipped, all-killed-hidden; (e) `npm test` green; (f) ledger order and scoring untouched.

### Task 4: Priority-side stall nudge naming the oldest unreviewed row past 48h

- Owned files: `public/app.js`, `public/dashboard.test.mjs`.
- Acceptance: (a) toolbar shows a read-only `Nudge: "<title>" unreviewed Nd [Open it]` line only when the queue is non-empty and `oldest_unreviewed_age_h > 48`; (b) one click opens the oldest row's drawer; (c) silent when the queue is empty or fresh; (d) dashboard static tests cover shown/hidden + 48h gate; (e) `npm test` green; (f) no auto-vet, no status moves.
