# AUDIT-2026-09-20-round2 — aimoney

Clone: `/mnt/c/coding-projects/_workspace/night-aimoney-r2` (read-only; no writes except this file). HEAD `e5a12a1` ("Night round 1 (aimoney): Implemented all 3 audit next-tasks"), which matches live health `rev:"e5a12a1"`.
Live snapshots read: `_night/live/aimoney_pages_dev.html` (HTTP 200, 5304 bytes), `_night/live/aimoney_pages_dev_api_health.html` (HTTP 200, 230 bytes).
No `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING` in clone (glob search, zero hits); `README.md` used as governing doc. `.env`/secrets/`.dev.vars` never read. Shell used as single-stage commands only.
Lane metric (aimoney row): experiments reaching a decision (won/lost with post-mortem) per week, plus vetted proposals becoming experiments, plus unreviewed backlog drained. Current value from the repo's own live data: **decisions/week = 0** (`experiments_by_status:{"planned":2}`, zero `running`/`won`/`lost` ever surfaced), **unreviewed 11/27 with oldest 148.2h (~6.2d)**, **bare-without-brief 19/27**. Findings below are ranked by movement on that number.

## 1. What this project is and how it runs

- Purpose: AIMoney Lab — ranked AI-money opportunities with scores, research briefs, experiments, and a cron research agent that proposes/refreshes rows.
- Entry points: dashboard `public/index.html` + `public/app.js`; API `functions/api/[[path]].js`; agent `worker/src/index.js` + `worker/src/lib.js`; DB `d1/schema.sql` + `d1/seed.sql`.
- Live surfaces: `https://aimoney.pages.dev`, `https://aimoney.pages.dev/api/health`, worker `https://aimoney-research.<account>.workers.dev` (`GET /`, `POST /run`, `GET /ping-ai`, `GET /debug-classify`).
- Scheduled jobs: worker cron `0 */6 * * *` (`worker/wrangler.toml:9`) — collect signals, AI triage (≤6 signals, ≤4 AI calls), 1 brief per tick, log to `agent_runs`.
- How it deploys: `./deploy/deploy.sh` (D1 schema + seed-if-empty, stamp `public/release.json`, Pages deploy, worker deploy); Git-connected Pages rebuild via `scripts/stamp-release.sh` + `.github/workflows/deploy-worker.yml` on `worker/**` push; `./deploy/verify.sh` checks markers + non-empty list + freshness ≤12h.

## 2. End-to-end walk-through

Main loop: signal found → agent proposal → human vet → experiment → close with learning → rescore.

1. Cron/manual triggers pass: `worker/src/index.js:332-333` (`scheduled` → `runResearch(env,"cron")`) and `worker/src/index.js:388-396` (`POST /run` → `waitUntil(runResearch(env,"manual"))`, 202 `{status:"accepted"}`).
2. Collect signals in parallel: `worker/src/index.js:176` (`Promise.allSettled([hnSignals(), redditSignals(), githubSignals()])`); sources `worker/src/index.js:47-69` (HN ×4), `worker/src/index.js:71-93` (Reddit ×3), `worker/src/index.js:95-116` (GitHub, `slice(0, 2)` of 3 queries); fetch helper `worker/src/index.js:35-45` (`timedJson`, 6s abort covering body read).
3. Batch-insert signals + heartbeat: `worker/src/index.js:181-186` (`INSERT OR IGNORE INTO signals`, one `DB.batch`); `worker/src/index.js:187-191` (`phase:collected/classify-ai/...`); reap stuck runs `worker/src/index.js:145-150` (`running` older than 30 min → `error`).
4. Classify fresh signals vs live list: `worker/src/index.js:192-194` (`processed=0 LIMIT 6`); `worker/src/index.js:201-203` (top-60 opps); `worker/src/index.js:217-221` (`aiComplete` Mistral NDJSON); parse `worker/src/lib.js:49-64` (`parseJsonLines`, first-`{...}`-per-line + `repairJson` for `\_`).
5. Apply verdicts: new → `worker/src/index.js:242-266` (`INSERT INTO opportunities ... status="researching"`, capped `effectiveScore`, notes carry `UNREVIEWED`); supports → `worker/src/index.js:267-275` (`substr(notes || ?,-8000)`, newest kept); noise/invalid → `worker/src/index.js:276-278` / `worker/src/index.js:232-235` (marked `processed=1`).
6. Brief one bare opp (cron only): `worker/src/index.js:283-285` (`LEFT JOIN briefs ... WHERE b.id IS NULL ORDER BY o.score DESC LIMIT 1`, skipped when `Date.now()-t0 >= briefDeadline`, and manual always skips via `briefDeadline=-1` at `worker/src/index.js:174`); `worker/src/index.js:291-303` (Llama brief JSON); `worker/src/index.js:310-318` (`INSERT INTO briefs`, skipped if `summary`/`first_steps` empty).
7. Finish run: `worker/src/index.js:161-167` (`UPDATE agent_runs SET finished_at,status,signals_seen,added,updated,briefs,ai_calls,error`).
8. Board reads: `public/app.js:520-537` (`refresh()` loads `/api/opportunities?limit=200`, `/api/experiments`, `/api/runs?limit=20`, `/api/health`, `/api/meta`, each `.catch` to empty); list `functions/api/[[path]].js:39-66` (`unreviewed=1` filter, `oldest` sort, `effectiveScore` cap, re-sort by effective score); review view `public/app.js:88-129` + chip `public/index.html:49` (`Needs review (N · oldest Nd)` via `oldest_unreviewed_age_h`).
9. Human vets: `public/app.js:149-165` (Vet strips `UNREVIEWED`, lifts cap) / `public/app.js:167-185` (Kill sets `killed` + post-mortem prompt) → `functions/api/[[path]].js:115-146` (`PATCH /api/opportunities/:id`, rescore via shared `effectiveScore`).
10. Experiment loop: log/update `public/app.js:449-494` (`openExperimentModal`) → `functions/api/[[path]].js:220-237` (create) / `functions/api/[[path]].js:239-271` (update: `running` stamps `started_at`, `won`/`lost` require `result`+`post_mortem` and stamp `ended_at`, invalid status 400); board `public/app.js:211-237` (stale-first, `Nd` age chips, `orphaned` pill); detail drawer `public/app.js:281-323` + admin re-optimize `public/app.js:333-378`.
11. Health/verify: `functions/api/[[path]].js:286-311` (`/api/health`: `rev,db,opportunities,unreviewed,bare_without_brief,experiments_by_status,hours_since_last_ok_run,oldest_unreviewed_age_h,time`); `deploy/verify.sh:28-58` (6 markers + non-empty list + freshness ≤12h).

Where it most often breaks or goes silent: the human bottleneck after hop 5, now quantified: live health shows `unreviewed:11/27` with `oldest_unreviewed_age_h:148.2` (~6.2 days at a 6h cadence), `bare_without_brief:19/27`, and `experiments_by_status:{"planned":2}` with zero `running`/`won`/`lost` — i.e. decisions/week is 0 and nothing on the board measures it (see F1). Briefing does 1/tick (`worker/src/index.js:283-285`) while proposals append every run, so the queue grows faster than vetting; status moves are manual-only (`worker/src/index.js:4-5`, `README.md:71`). Secondary silent spots: invalid verdicts marked `processed=1` and dropped (`worker/src/index.js:232-235`); manual runs never brief (`worker/src/index.js:174`) with no UI/API disclosure (F5); dashboard `api().catch(()=>...)` (`public/app.js:521-531`, `public/app.js:120-124`) renders empty sections instead of errors (F4).

## 3. Health signals measured here

- Test suite (`npm test` = `node --test worker/src/lib.test.js functions/api/api.test.mjs public/tab-icon.test.mjs`): PASS, 32/32, 13 suites, 0 fail. Real tail: `# tests 32 / # suites 13 / # pass 32 / # fail 0 / # duration_ms 329.208306`. Up from round 1's 27 (new age + orphan suites). Brief's Windows baseline (126.7303 ms) is a different machine; same all-green result. Warnings only: `UNDICI-EHPA` proxy-agent notice and `MODULE_TYPELESS_PACKAGE_JSON` reparsing hint for `[[path]].js`/`lib.test.js` (add `"type":"module"` to silence; no behavior change).
- Syntax checks: `node --check public/app.js` → exit 0; `node --check worker/src/index.js` → exit 0 (each with only the `UNDICI-EHPA` warning). `functions/api/[[path]].js` and `worker/src/lib.js` are executed green by `npm test` instead of a separate `--check`.
- `python3 -m compileall -q`: NOT RUN — no Python sources in repo (glob `**/*.py` returns zero files) and `compileall` would write `__pycache__` into this read-only clone. The `node --check` results above are the real syntax signal.
- Dead code (inspected, not guessed): `worker/src/index.js:20` defines `const BRIEF_DEADLINE_MS = 18000` but the pass uses the literal `300000` at `worker/src/index.js:174` — the constant has zero other references (repo-wide regex search confirms). `worker/src/index.js:139` imports `scoreOf` but the file never calls it (only `clamp10/slugify/effectiveScore/parseJsonLines/repairJson`). `worker/src/lib.js:36-39` exports `appendKeepNewest` yet production uses SQL `substr(notes || ?,-8000)` (`worker/src/index.js:271-275`); the helper's only callers are its tests (`worker/src/lib.test.js:89-102`). `worker/src/index.js:115` (`GITHUB_QUERIES.slice(0, 2)`) silently drops the third query (`ai-side-project`, `worker/src/index.js:27`) with no comment.
- Duplicated logic: `clamp10` exists twice — `functions/api/[[path]].js:12-16` (checks `Number(v)` finite, then rounds; caller must pass the default) vs `worker/src/lib.js:4-7` (rounds first, then checks; defaults to 5). They agree on common inputs but are two implementations of one rule with no shared import. `scoreOf`/`effectiveScore` are correctly shared (`functions/api/[[path]].js:10` imports from `worker/src/lib.js`; cross-boundary test `functions/api/api.test.mjs:192-203` locks agreement). Auth compare is duplicated with divergent semantics: constant-time loop in API (`functions/api/[[path]].js:21-29`) vs `!==` in worker (`worker/src/index.js:345`, `worker/src/index.js:360`, `worker/src/index.js:391`).
- TODO density: 0. Regex search for `TODO|FIXME|XXX|HACK|TBD|console\.log|debugger` returns zero matches in source (the only hit is the round-1 audit doc describing this same check). No `console.log`/`debugger` in shipped `public/app.js` (verified by read).
- Live snapshot (read-only, from `_night/live/`): dashboard HTML matches repo `public/index.html` byte-for-byte in structure (title `AIMoney Lab — ranked ways to make money with AI`, favicon link + `theme-color #0d6b3f` at lines 9-10, inline brand SVG in header at line 16 reusing the favicon's `#0d6b3f` rounded square + `$` glyph, `color-scheme: light` with no dark branch, review-age chip at line 49). 5304 bytes, light, first paint tells the product in one headline ("Every way to make money with AI, ranked.") with three clear tabs. Health JSON: `{"ok":true,"rev":"e5a12a1","db":"up","opportunities":27,"unreviewed":11,"bare_without_brief":19,"experiments_by_status":{"planned":2},"hours_since_last_ok_run":4.6,"oldest_unreviewed_age_h":148.2,"time":"2026-09-20T04:33:20.094Z"}` — fresh run (4.6h), live rev equals clone HEAD, but 41% unreviewed with a 6.2-day-old tail, 70% bare, zero running/won/lost experiments. All four page standing rules currently pass, guarded by `public/tab-icon.test.mjs:62-96`, so no surface finding is spent below.
- Tree note (honest blocker for Acceptance): `git status --short` showed all 26 tracked files `M` BEFORE I wrote anything; `git diff -- public/favicon.svg` proves it is a checkout artifact (blob LF vs worktree CRLF, zero content change; `git diff --stat` shows 4612 insertions = 4612 deletions). I preserved it untouched per worker scope. After this file, the tree holds that pre-existing CRLF state plus only `AUDIT-2026-09-20-round2.md` as the new file; `_night/` scratch is untracked runner state.

## 4. Ranked findings (max 8)

### F1 — Decisions/week is 0 and nothing measures it — the lane metric is invisible

- Evidence: `_night/live/aimoney_pages_dev_api_health.html:1` → `"experiments_by_status":{"planned":2}` (no `running`/`won`/`lost` keys at all); seed still `planned` in `d1/seed.sql:67-71`; board summary counts totals only in `public/app.js:216-218` (`` `${exps.length} experiments · ${running} running · ${won} won` ``, no time window); `/api/health` (`functions/api/[[path]].js:286-311`) has no won/lost-in-window field; regex search for `decisions_7d|decisions per` returns zero source hits.
- Why it costs money: the lane exists to move "experiments that reach a decision per week," currently 0, and the board can look busy (27 opps, fresh agent runs) while learning nothing. Stale-first age chips (round 1) show drift but never answer "did we decide anything this week."
- Fix: add `decisions_7d` (COUNT of experiments with `status IN ('won','lost')` and `ended_at` within 7 days) to `/api/health` in `functions/api/[[path]].js`; show an "N decisions this week" chip in the Experiments toolbar (`public/index.html`, `public/app.js`); add an `api.test.mjs` case with stubbed `ended_at` values. Keep it read-only surfacing — humans still close experiments. Touch `functions/api/[[path]].js`, `public/app.js`, `public/index.html`, `functions/api/api.test.mjs`.
- Size: M. Risk: low (additive health key + display; existing keys stable for `verify.sh`).

### F2 — Review queue is not draining: 6.2-day-old tail, 70% bare, 1 brief/tick, no backlog SLO

- Evidence: health `unreviewed:11`, `oldest_unreviewed_age_h:148.2`, `bare_without_brief:19` of 27 opps; briefing is one row per cron tick in `worker/src/index.js:283-285` → `` `SELECT o.* FROM opportunities o LEFT JOIN briefs b ON b.opportunity_id = o.id WHERE b.id IS NULL ORDER BY o.score DESC LIMIT 1` ``; `deploy/verify.sh:50-58` gates only run freshness (≤12h), never backlog age/count, so a 6-day queue still verifies green.
- Why it costs money: vetted-proposals-becoming-experiments (the lane's second metric) is starved at the vetting step; capped scores (≤6000 via `worker/src/lib.js:29-32`) keep the best unvetted ideas below the fold while the tail ages past a week.
- Fix: gate the backlog, not just freshness: extend `deploy/verify.sh` to warn (non-failing first) when `oldest_unreviewed_age_h > 48` or `unreviewed/opportunities > 0.3` — both already exposed by `/api/health`, no API change needed. If the tail persists, brief a second row per tick (oldest-unreviewed bare row) when backlog age exceeds 48h. Owner gate: `verify.sh` is a deploy script, which standing rule 5 protects — needs explicit say-so. Touch `deploy/verify.sh` (optionally `worker/src/index.js`, `functions/api/api.test.mjs`).
- Size: S (verify-only) / M (with second brief). Risk: low (warn-first; no auto-vetting, human-owns-status untouched).

### F3 — `POST /api/experiments` bypasses the closure guards: learning-free "decisions" and instant orphans

- Evidence: `createExperiment` in `functions/api/[[path]].js:220-237` accepts any `EXP_STATUSES` value including `won`/`lost` with no `result`/`post_mortem` check and no `opportunity_id`-exists check; `updateExperiment` in `functions/api/[[path]].js:250-262` 400s on both (`result is required to close as won/lost`, `post_mortem is required...`, `invalid status`). A direct `POST {status:"won"}` or a bogus `opportunity_id` succeeds at create and would fail at update.
- Why it costs money/users/trust: F1's future decisions/week metric is gameable from day one — closed rows with no learning — and bogus ids create `orphaned` cards immediately instead of erroring at the boundary.
- Fix: extract the close-validation block (`won`/`lost` require `result` + `post_mortem`, stamp `ended_at`; invalid status 400) into one helper called by both create and update paths, and 404 when `opportunity_id` matches no opportunity. Add `api.test.mjs` cases: create-as-`won` without `result` → 400, bogus `opportunity_id` → 404, valid create → 201. Touch `functions/api/[[path]].js`, `functions/api/api.test.mjs`.
- Size: S. Risk: low (tightens an endpoint no legitimate client uses this way; existing tests pin update behavior).

### F4 — Dashboard swallows API failures: a dead backend renders as a healthy empty board

- Evidence: `public/app.js:521-531` — all five boot fetches (opportunities, experiments, runs, health, meta) `.catch(() => empty)`; `public/app.js:120-124` (`refreshReview` catch → `[]`); the only visible error path `public/app.js:538-540` (`API unreachable...`) sits outside `refresh()` and can never fire because the inner catches never reject. D1 down ⇒ "Nothing here…", "No experiments yet.", "No agent runs yet — the first cron pass lands within 6h" — all calm, all wrong.
- Why it costs money/trust: the operator cannot distinguish "loop idle" from "loop broken"; money-loop stalls (F1's zero) read as a quiet board instead of an outage, delaying the fix by days.
- Fix: collect per-fetch failures inside `refresh()` and render one warning banner (e.g. "API unreachable: opportunities, health — showing empty, not stale") reusing existing toast/banner styles, plus keep the boot-level message as fallback. The repo has no DOM test harness, so acceptance is a downed-API manual check (stop D1 binding / block `/api/*`) plus `npm test` green. Touch `public/app.js`, `public/index.html`, `public/styles.css`.
- Size: S. Risk: low (display-only; no fetch or API behavior change).

### F5 — Manual "Run research now" is still undisclosed triage-only

- Evidence: button copy unchanged in `public/index.html:26` → `Run research now`; toast promises a full pass in `public/app.js:511` → `Research pass started — watch the Research log tab for results.`; but `worker/src/index.js:174` → `const briefDeadline = trigger === "cron" ? 300000 : -1;` plus `worker/src/index.js:283` means manual always skips the brief phase; `POST /run` returns bare `{status:"accepted"}` in `worker/src/index.js:388-396`. Regex search for `briefs_skipped` in source: zero hits.
- Why it costs users/trust: operators click expecting a brief, get none, and re-click — burning the ≤4-AI-call budget on repeat triage while the 19-row bare backlog (F2) waits for cron.
- Fix: relabel the button "Run triage now (briefs on cron)" in `public/index.html`/`public/app.js`; include `briefs_skipped:true, reason:"manual runs triage only; briefs land on cron ticks"` in the `/run` 202 response in `worker/src/index.js` and reflect it in the toast. No scheduling change. Touch `public/index.html`, `public/app.js`, `worker/src/index.js`.
- Size: S. Risk: low (copy + additive response field).

### F6 — `PATCH /api/opportunities` silently ignores an invalid status while the UI reports "Saved"

- Evidence: `functions/api/[[path]].js:126` → `if (b.status !== undefined && OPP_STATUSES.has(b.status)) next.status = b.status;` (invalid value silently dropped) vs experiments' explicit 400 with field reason in `functions/api/[[path]].js:250-252`; the admin save toast in `public/app.js:372` → `` `Saved — new score ${r.score}` `` fires regardless.
- Why it costs money/trust: status moves (`researching → testing → scaling`) are THE human money action in this loop; a typo'd move silently no-ops while the operator believes it moved — the board then misstates pipeline state for weeks.
- Fix: mirror the experiment behavior — return 400 `{error:"invalid status: ...", field:"status"}` on unknown status in `updateOpportunity`, and add an `api.test.mjs` case asserting 400 plus an unchanged row. Touch `functions/api/[[path]].js`, `functions/api/api.test.mjs`.
- Size: S. Risk: low (invalid statuses previously no-opped; no legitimate client depends on silent ignore).

### F7 — Auth compare differs between API and worker (timing signal + collapsed codes)

- Evidence: API constant-time loop in `functions/api/[[path]].js:21-29` (`for (...) diff |= want.charCodeAt(i) ^ got.charCodeAt(i)`); worker uses `!==` in three places (`worker/src/index.js:345`, `worker/src/index.js:360`, `worker/src/index.js:391` → `if (!want || got !== want) return json({ error: "unauthorized" }, 401);`). API distinguishes `503 writes disabled` vs `401 bad token` (`functions/api/[[path]].js:83`); worker collapses both to `401`.
- Why it costs trust: timing side-channel on the worker token plus inconsistent operator signals (same misconfiguration yields different codes on Pages vs worker), slowing incident triage.
- Fix: extract the constant-time compare into `worker/src/lib.js` (pure, unit-testable), import it in both `worker/src/index.js` and `functions/api/[[path]].js`, and align worker responses (`503` when `ADMIN_TOKEN` unset, `401` on mismatch). Add `worker/src/lib.test.js` cases for length-mismatch and empty-secret. Touch `worker/src/lib.js`, `worker/src/index.js`, `functions/api/[[path]].js`, `worker/src/lib.test.js`.
- Size: S. Risk: low (auth semantics tighten; keep token values out of logs; existing tests verify both sides).

### F8 — Dead constant + unused import + test-only helper + silent query trim invite the next wrong edit

- Evidence: `worker/src/index.js:20` (`const BRIEF_DEADLINE_MS = 18000;`) never referenced — the pass uses the literal `300000` at `worker/src/index.js:174`; `worker/src/index.js:139` imports `scoreOf`, never called in that file; `worker/src/lib.js:36-39` (`appendKeepNewest`) has tests (`worker/src/lib.test.js:89-102`) but zero production callers (production uses SQL `substr(...,-8000)`, `worker/src/index.js:271-275`); `worker/src/index.js:27` lists 3 GitHub queries but `worker/src/index.js:115` runs `slice(0, 2)` with no comment; `clamp10` duplicated (`functions/api/[[path]].js:12-16` vs `worker/src/lib.js:4-7`).
- Why it costs money/maintainability: the next editor tunes `BRIEF_DEADLINE_MS` and wonders why briefs never shift; the SQL-vs-helper split can drift silently; the dropped GitHub query reads as a bug or a quota hack with no comment; two `clamp10`s can diverge on edge inputs.
- Fix: delete `BRIEF_DEADLINE_MS` or wire it as the cron deadline with a comment; drop `scoreOf` from the worker import; demote `appendKeepNewest` to a documented test oracle with a comment pointing at the SQL mirror (or call it from one JS-side notes path); add a one-line comment on the GitHub `slice(0, 2)` (rate-limit vs forgotten); optionally import the shared `clamp10` in the API. Touch `worker/src/index.js`, `worker/src/lib.js` (optionally `functions/api/[[path]].js`).
- Size: S. Risk: negligible (cleanup + comments; no behavior change).

## 5. What NOT to change

- Scoring formula and honest seeds: `score = 100 * (value * confidence * fit) / (effort + 1)`, each input 1–10 (`README.md:56`; `worker/src/lib.js:15-16`). The 12 seed scores recompute exactly; do not retune values or weights without new evidence.
- Human-owns-status: "The agent never moves status." (`README.md:71`); "The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed)." (`worker/src/index.js:4-5`); "`researching → testing` is a human decision: flip to `testing` when you start a real experiment ... The agent never moves status." (`README.md:71`). Do not add auto-transitions; F1/F2 propose surfacing only.
- Killed-with-learning: "Killed strategies stay on the board with their post-mortem — that is the point." (`README.md:64`); "Closing an experiment as `won`/`lost` requires `result` + `post_mortem`; `ended_at` stamps automatically." (`README.md:73`). Do not purge killed rows or relax closure rules — F3 tightens creation to match them.
- Capped humility for proposals: "Agent proposals enter as `researching` with an `UNREVIEWED` marker in notes and an effective score capped to ≤6000 until a human vets them" (`README.md:65`); "A human admin vets each row: "Vet" clears the `UNREVIEWED` marker (keeps status, lifts the 6000 cap); "Kill" sets `killed` and requires a one-line post-mortem in notes." (`README.md:70`). Vet/kill stay human; F2 proposes backlog gating, never auto-vetting.
- Seed-vs-live accounting: "Seed runs once on an empty table; live count = 12 seeds + agent proposals + manual adds. Killed rows stay listed, so the count only grows." (`README.md:77`). Do not re-seed over live data; deploy's seed-if-empty (`deploy/deploy.sh:30-42`) stays.
- Auth split and secrets: "Reads are public. Writes require `Authorization: Bearer <ADMIN_TOKEN>`." (`functions/api/[[path]].js:1-2`); "`ADMIN_TOKEN` lives in two places: the Pages env var and the worker secret ... No expiry; rotate manually when shared or leaked." (`README.md:80-81`). Anything needing `ADMIN_TOKEN`, `CLOUDFLARE_API_TOKEN`, D1 execute, or wrangler deploy is operator-owned and credential-gated — out of scope for code edits.
- Anything needing a login, payment, or human judgment: vetting `UNREVIEWED` rows, moving `researching → testing → scaling`, writing post-mortems, choosing niches/pricing/outreach, rotating tokens. This audit proposes surfacing and guardrails only, never auto-vetting, auto-scaling, or auto-spend.
- Deploy/CI surface without say-so: standing rule 5 ("do not touch data files, secrets, `.env`, deploy scripts or CI configuration unless the task says so") protects `deploy/deploy.sh`, `deploy/verify.sh`, `.github/workflows/deploy-worker.yml`, and `public/release.json` (a build-stamped placeholder — `{"project":"aimoney","revision":"dev-undeployed",...}` — overwritten by `scripts/stamp-release.sh`/`deploy.sh`; never hand-edit). F2's `verify.sh` change needs explicit owner approval.
- The cited round-1 feature branch `night/aimoney-round1 (b86d2b0)` ("decisions per week, triage-only runs, API failure warnings") is not this tree — HEAD here is `e5a12a1` and no network was available to fetch it. Do not re-implement its contents blind; diff/merge it first so F1/F4/F5 do not land twice.

## 6. Proposed next tasks (2–4)

### Task 1: Count experiment decisions per week on /api/health and the board

- Owned files: `functions/api/[[path]].js`, `public/app.js`, `public/index.html`, `functions/api/api.test.mjs`.
- Acceptance: (a) `/api/health` reports `decisions_7d` (won/lost by `ended_at` ≤7d) with a new API test green; (b) Experiments toolbar shows an "N decisions this week" chip reading that field; (c) `npm test` 32+/32+ green; (d) no status auto-move — humans still close experiments; (e) existing health keys byte-stable for `verify.sh`.

### Task 2: Enforce experiment closure + opp-exists guards on create

- Owned files: `functions/api/[[path]].js`, `functions/api/api.test.mjs`.
- Acceptance: (a) `POST /api/experiments {status:"won"}` without `result`+`post_mortem` → 400 with `fields` (new test); (b) `POST` with bogus `opportunity_id` → 404 (new test); (c) valid `POST` → 201 unchanged; (d) `npm test` green; (e) no migration — validation-only change.

### Task 3: Show an API-failure banner instead of silent empty sections

- Owned files: `public/app.js`, `public/index.html`, `public/styles.css`.
- Acceptance: (a) with `/api/*` unreachable, the board shows one banner naming the failed sections instead of calm empty states; (b) with the API up, no banner appears; (c) `npm test` green (tab-icon/light-mode/brand guards still pass); (d) no fetch or API behavior change.

### Task 4: Disclose manual runs as triage-only in UI and /run

- Owned files: `public/index.html`, `public/app.js`, `worker/src/index.js`.
- Acceptance: (a) button reads "Run triage now (briefs on cron)"; (b) `POST /run` 202 includes `briefs_skipped:true` + reason; (c) toast after triggering reflects triage-only; (d) `npm test` green; (e) no scheduling change — cron still owns briefs.
