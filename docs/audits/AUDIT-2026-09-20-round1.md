# AUDIT-2026-09-20-round1 — aimoney (round)

Clone: `/mnt/c/coding-projects/_workspace/night-aimoney-r1` at `e5a12a1` (read-only; no writes except this file).
Live snapshots read: `_night/live/aimoney_pages_dev.html` (5304 bytes, HTTP 200), `_night/live/aimoney_pages_dev_api_health.html` (230 bytes, HTTP 200).
No `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING` in clone; `README.md` used as governing doc. `.env`/secrets never read.
Prior round (`e5a12a1`) implemented all 3 next-tasks from `docs/audits/AUDIT-2026-09-20-round1.md`: stale-age surfacing, header brand mark, orphan-safe list — all verified present below.

Lane metric (aimoney row): experiments reaching a decision (`won`/`lost` with post-mortem) per week, plus vetted proposals becoming experiments, with the unreviewed backlog drained. Current value from the repo's own live data: **0 decisions** (`experiments_by_status":{"planned":2}`, zero `running`/`won`/`lost`), **11 unreviewed (oldest 147.9h ≈ 6.2d)**, **19/27 bare without brief**; vetted-to-experiment conversion is **unmeasured** (no API field counts it).

## 1. What this project is and how it runs

- Purpose: Cloudflare-native AIMoney Lab — ranked AI-money opportunities with scores, research briefs, experiments, and a cron research agent.
- Entry points: dashboard `public/index.html` + `public/app.js`; API `functions/api/[[path]].js`; agent `worker/src/index.js` + `worker/src/lib.js`; DB `d1/schema.sql`.
- Live surfaces: `https://aimoney.pages.dev`, `https://aimoney.pages.dev/api/health`, worker `https://aimoney-research.<account>.workers.dev`.
- Scheduled jobs: worker cron `0 */6 * * *` (`worker/wrangler.toml:9`) — collect signals, AI triage, 1 brief per cron tick, log to `agent_runs`.
- How it deploys: `./deploy/deploy.sh` (D1 schema + seed-if-empty, stamp `public/release.json`, Pages deploy, worker deploy); Pages Git-connected rebuild + `.github/workflows/deploy-worker.yml` on `worker/**` push; `./deploy/verify.sh` checks markers + 12h freshness.

## 2. End-to-end walk-through

Main loop: signal found → agent proposal → human vet → experiment → close with learning → rescore.

1. Cron/manual triggers pass: `worker/src/index.js:332-333` (`scheduled` → `runResearch(env,"cron")`) and `worker/src/index.js:388-396` (`POST /run` → `waitUntil(runResearch(env,"manual"))`, 202 `accepted`).
2. Collect signals in parallel: `worker/src/index.js:176` (`Promise.allSettled([hnSignals(), redditSignals(), githubSignals()])`); sources `worker/src/index.js:47-69` (HN ×4), `worker/src/index.js:71-93` (Reddit ×3), `worker/src/index.js:95-116` (GitHub, `slice(0,2)` of 3 queries); fetch helper `worker/src/index.js:35-45` (`timedJson`, 6s abort covering body read).
3. Batch-insert signals + heartbeat: `worker/src/index.js:181-186` (`INSERT OR IGNORE INTO signals`, one `DB.batch`); `worker/src/index.js:187-191` (`phase:collected/classify-ai/...` heartbeat); reap stuck runs `worker/src/index.js:145-150` (`running` older than 30 min → `error`).
4. Classify fresh vs live list: `worker/src/index.js:192-194` (`SELECT * FROM signals WHERE processed=0 LIMIT 6`); `worker/src/index.js:201-203` (top-60 opps); `worker/src/index.js:217-221` (`aiComplete` Mistral NDJSON); parse `worker/src/lib.js:49-64` (`parseJsonLines` + `repairJson` for `\_`).
5. Apply verdicts: new → `worker/src/index.js:242-266` (`INSERT INTO opportunities … status="researching"`, `effectiveScore({…,"UNREVIEWED"})` capped ≤6000); supports → `worker/src/index.js:267-275` (`substr(notes || ?,-8000)`, newest kept); noise/invalid → `worker/src/index.js:276-278` / `worker/src/index.js:232-235` (marked `processed=1`, dropped).
6. Brief one bare opp (cron only): `worker/src/index.js:283-285` (`LEFT JOIN briefs … WHERE b.id IS NULL ORDER BY o.score DESC LIMIT 1`, skipped when `Date.now()-t0 >= briefDeadline`); `worker/src/index.js:291-303` (Llama brief JSON); `worker/src/index.js:310-318` (`INSERT INTO briefs`, skipped if `summary`/`first_steps` empty).
7. Finish run: `worker/src/index.js:161-167` (`UPDATE agent_runs SET finished_at,status,signals_seen,added,updated,briefs,ai_calls,error`).
8. Board reads: `public/app.js:520-537` (`refresh()` loads `/api/opportunities?limit=200`, `/api/experiments`, `/api/runs?limit=20`, `/api/health`, `/api/meta`); list `functions/api/[[path]].js:39-66` (`unreviewed=1` filter, `oldest` sort, shared `effectiveScore` cap, re-sort); review chip + age `public/app.js:120-143`; review view `public/app.js:88-118`.
9. Human vets: `public/app.js:149-165` (Vet strips `UNREVIEWED`, lifts cap, keeps status) / `public/app.js:167-185` (Kill sets `killed` + prompted post-mortem) → `functions/api/[[path]].js:115-146` (`PATCH /api/opportunities/:id`, rescore via shared `effectiveScore`).
10. Experiment loop: log/update `public/app.js:449-494` (`openExperimentModal`) → `functions/api/[[path]].js:220-237` (create) / `functions/api/[[path]].js:239-271` (update: `running` stamps `started_at`, `won`/`lost` require `result`+`post_mortem` and stamp `ended_at`, invalid status 400); list with age/orphan `functions/api/[[path]].js:198-218` (`days_in_status`, `orphaned` via `LEFT JOIN`); board stale-first + age chips `public/app.js:204-237`; detail drawer + admin re-optimize `public/app.js:281-378`.
11. Health/verify: `functions/api/[[path]].js:286-312` (`/api/health`: `rev,db,opportunities,unreviewed,bare_without_brief,experiments_by_status,hours_since_last_ok_run,oldest_unreviewed_age_h,time`); `deploy/verify.sh:28-58` (7 markers + non-empty list + freshness ≤12h).

Where it most often breaks or goes silent: the human bottleneck after hop 5, unchanged since the prior round. Live health proves it: `unreviewed:11/27` (41%, oldest 147.9h), `bare_without_brief:19/27` (70%), `experiments_by_status:{"planned":2}` with zero `running`/`won`/`lost` — and the prior snapshot at `b92e2eb` showed the identical `27/11/19/planned:2`, i.e. **zero queue movement between rounds** despite fresh runs (`hours_since_last_ok_run:4.2`). Briefing does 1/cron-tick (`worker/src/index.js:283-285`) while proposals append every run; status moves are manual-only (`worker/src/index.js:4-5`, `README.md:71`), vetted rows stay `researching` with no next step (`public/app.js:149-165`), and nothing measures decisions/week or vetted→experiment conversion. Secondary silent spots: invalid verdicts marked `processed=1` and dropped (`worker/src/index.js:232-235`); manual runs never brief (`briefDeadline=-1`, `worker/src/index.js:174`); dashboard `api().catch(()=>({}))` (`public/app.js:521-526`) renders empty sections instead of errors.

## 3. Health signals measured here

- Test suite (`npm test` = `node --test worker/src/lib.test.js functions/api/api.test.mjs public/tab-icon.test.mjs`): **PASS, 32/32, 13 suites, 0 fail**. Real tail: `# tests 32 / # suites 13 / # pass 32 / # fail 0 / # cancelled 0 / # duration_ms 347.256633`. Prior round was 27/27; +5 from the 3 implemented tasks (age, brand-mark, orphan tests). Warnings only: `UNDICI-EHPA` proxy-agent notice and `MODULE_TYPELESS_PACKAGE_JSON` reparsing hint for `[[path]].js`/`lib.test.js` (add `"type":"module"` to silence; no behavior change).
- Syntax checks (no writes): `node --check public/app.js` → exit 0; `node --check worker/src/index.js` → exit 0; `node --check worker/src/lib.js` → exit 0; `node --check functions/api/api.test.mjs` → exit 0; `node --check public/tab-icon.test.mjs` → exit 0 (each with only the `UNDICI-EHPA` warning). `node --check` on `functions/api/[[path]].js` not run separately (bracketed path); the file is imported and exercised green by `npm test` instead.
- `python3 -m compileall -q`: NOT RUN — no Python sources in repo (glob `**/*.py` returns zero files) and `compileall` would write `__pycache__` into this read-only clone. The `node --check` line above is the real syntax signal.
- Dead code (inspected, not guessed): `worker/src/index.js:20` defines `const BRIEF_DEADLINE_MS = 18000` but the pass uses `worker/src/index.js:174` (`trigger==="cron" ? 300000 : -1`) — the constant is never referenced. `worker/src/index.js:139` imports `scoreOf` but the file only calls `clamp10/slugify/effectiveScore/parseJsonLines/repairJson`. `worker/src/lib.js:36-39` exports `appendKeepNewest` yet production uses SQL `substr(notes || ?,-8000)` (`worker/src/index.js:271-275`); the helper is test-only. `worker/src/index.js:115` (`GITHUB_QUERIES.slice(0,2)`) silently drops the third query (`ai-side-project`, `worker/src/index.js:27`). All four survive from the prior round (see F8).
- Duplicated logic: `clamp10` exists twice — `functions/api/[[path]].js:12-16` vs `worker/src/lib.js:4-7` (same bounds/rounding; kept in sync by inspection only, no shared import). `scoreOf`/`effectiveScore` are correctly shared (`functions/api/[[path]].js:10` imports from `worker/src/lib.js`; cross-boundary test `functions/api/api.test.mjs:192-203` locks agreement). Auth compare is duplicated with divergent semantics: constant-time loop in API (`functions/api/[[path]].js:21-29`) vs `!==` in worker (`worker/src/index.js:343-345,359-360,389-391`, all `if (!want || got !== want) return json({ error: "unauthorized" }, 401);`).
- TODO density: 0. Regex search for `TODO|FIXME|XXX|HACK|TBD` returns zero matches in shipped code (only the prior audit's own mention in `docs/audits/`). No `console.log`/`debugger` in shipped `public/app.js` (regex search clean; verified by read).
- Live snapshot (read-only, from `_night/live/`): dashboard HTML content-matches repo `public/index.html` (title `AIMoney Lab — ranked ways to make money with AI`, favicon link + `theme-color #0d6b3f`, inline header brand SVG present); byte sizes differ only by CRLF (repo `public/index.html` 5422 bytes with CRLF line terminators per `file`, 118 lines × 1 CR byte = 118 = 5422−5304). Health JSON verbatim: `{"ok":true,"rev":"e5a12a1","db":"up","opportunities":27,"unreviewed":11,"bare_without_brief":19,"experiments_by_status":{"planned":2},"hours_since_last_ok_run":4.2,"oldest_unreviewed_age_h":147.9,"time":"2026-09-20T04:12:35.191Z"}` — rev matches HEAD, run fresh (4.2h), but 41% unreviewed (oldest 6.2d), 70% bare, zero running/won/lost.
- Surface rules (owner's 5): all PASS. Light palette only (`public/styles.css:4` → `color-scheme: light;`, zero `prefers-color-scheme`/`data-theme`/toggle hits in shipped HTML/CSS/JS); tab icon + theme-color on the served page (`public/index.html:9-10`); hand-written `public/favicon.svg:1` (32×32 viewBox, `#0d6b3f` rounded square, `$` glyph, 285 bytes < 2 KB, no external fonts); inline header brand mark reusing favicon geometry/accent/glyph (`public/index.html:16`, styled `public/styles.css:46`); guard test `public/tab-icon.test.mjs:48-113` (5/5 green: size, XML root, light-mode lock, brand-mark match, icon+theme-color links). No finding slots spent on surfaces.

## 4. Ranked findings (max 8)

Ordered by movement on the lane metric (decisions/week, vetted→experiment conversion, backlog drained). Prior-round F1–F3 (stale age, brand mark, orphans) are fixed and verified; they do not reappear.

### F1 — The money number reads zero and is itself unmeasured

- Evidence: `_night/live/aimoney_pages_dev_api_health.html:1` → `"experiments_by_status":{"planned":2}` (no `running`/`won`/`lost`); seed experiment still `'planned'` in `d1/seed.sql:67-71`; health returns no decisions/week in `functions/api/[[path]].js:311` (`{ ok, rev, db, opportunities, unreviewed, bare_without_brief, experiments_by_status, hours_since_last_ok_run, oldest_unreviewed_age_h, time }` — no `won`/`lost` rate, no vetted count); board summary counts running/won only in `public/app.js:216-218` (`` `${exps.length} experiments · ${running} running · ${won} won` `` — no lost, no rate, no post-mortem presence).
- Why it costs money: the lane exists to move decisions/week, but neither the API nor the dashboard computes it, so zero decisions looks identical to a healthy week. Vetted→experiment conversion is likewise invisible: vetting (`public/app.js:149-165`) keeps status `researching` with no link to a later experiment row.
- Fix: compute `decisions_last_7d` (`won`+`lost` with `ended_at` in window) and `vetted_last_7d` in the health handler from existing columns (no migration), and show `X decisions this week · Y vetted → Z experiments` on the Experiments tab header. Add API tests with dated `ended_at` rows. Touch `functions/api/[[path]].js`, `public/app.js`, `public/index.html`, `functions/api/api.test.mjs`.
- Size: M. Risk: low (read-only surfacing; existing health keys unchanged).

### F2 — Review queue frozen between rounds: 11 unreviewed, oldest 6.2d, zero drains

- Evidence: live `unreviewed:11`, `oldest_unreviewed_age_h:147.9` (`_night/live/aimoney_pages_dev_api_health.html:1`) vs prior snapshot `unreviewed:11` of 27 at `b92e2eb` (`docs/audits/AUDIT-2026-09-20-round1.md:41`) — identical counts, i.e. no vetting between rounds while `hours_since_last_ok_run:4.2` proves the agent keeps appending. Vet path `public/app.js:149-165` clears `UNREVIEWED` but keeps status with no next step; review view `public/app.js:88-118` is oldest-first but the chip never states a drain rate.
- Why it costs money: capped proposals (≤6000 via `worker/src/lib.js:29-32`) pile below the fold; every unvetted week delays the first real experiment on good ideas and the kill-with-learning on bad ones.
- Fix: add `reviewed_last_7d` (rows whose notes lost `UNREVIEWED`, or count via updated vetting tag) to `/api/health` and render `Needs review (11 · oldest 6d · 0 cleared/wk)` on the chip; when oldest exceeds 72h, show a one-line banner linking the oldest row. Keep vet/kill human-only. Touch `functions/api/[[path]].js`, `public/app.js`, `functions/api/api.test.mjs`.
- Size: S. Risk: low (read-only counters + copy).

### F3 — Brief backlog 70% bare; manual runs never brief and never say so

- Evidence: `bare_without_brief:19` of 27 (`_night/live/aimoney_pages_dev_api_health.html:1`); one bare row per cron tick in `worker/src/index.js:283-285` (`` `… WHERE b.id IS NULL ORDER BY o.score DESC LIMIT 1` ``); manual always skips via `worker/src/index.js:174` (`const briefDeadline = trigger === "cron" ? 300000 : -1;`) + `worker/src/index.js:283`; dashboard toast claims a full pass in `public/app.js:511` (`Research pass started — watch the Research log tab for results.`) and dead-ends only when the URL is unset in `public/app.js:500-501`.
- Why it costs users/trust: at 19 bare and ≤4 briefs/day (minus manual skips), coverage takes ~5 days with zero new proposals — but every run can add more. Operators clicking `Run research now` burn AI budget expecting a brief and get none, then re-click.
- Fix: disclose the split (button copy `Run triage now (briefs on cron)`; include `briefs_skipped:true, reason:"manual skips brief pass"` in the `/run` 202 response) and, when `oldest_unreviewed_age_h > 48`, brief one extra oldest-unreviewed bare row per cron tick —headroom exists (`MAX_AI_CALLS=4`, steady use is 2). Touch `worker/src/index.js`, `public/app.js`, `public/index.html`.
- Size: M. Risk: low-medium (+1 AI call on backlog ticks only; no scheduling change).

### F4 — Scores never learn: closing an experiment rescores nothing

- Evidence: `updateExperiment` (`functions/api/[[path]].js:239-271`) validates closure (`result`+`post_mortem` required, `ended_at` stamped) but never touches its opportunity; `updateOpportunity` (`functions/api/[[path]].js:115-146`) rescores only on manual field edits; no code path maps `won`/`lost` to `value`/`confidence`.
- Why it costs money: after the first real evidence lands, the board keeps ranking on pre-experiment guesses — winners stay under-ranked, losers stay over-ranked, and the next experiment picks wrong.
- Fix: on `won`/`lost` close, append a one-line outcome summary to the parent opportunity's notes (newest-kept, same `substr(…,-8000)` idiom) and surface a suggested (never auto-applied) confidence/value delta in the drawer admin zone for one-click human rescore. Keep human-owns-status. Touch `functions/api/[[path]].js`, `public/app.js`.
- Size: M. Risk: medium (touches the write path; keep `effectiveScore` shared and add API tests).

### F5 — Triage drops are invisible: noise + invalid verdicts vanish without a count

- Evidence: invalid action → `worker/src/index.js:232-235` (`UPDATE signals SET processed=1`, continue); `supports`-without-id demoted to noise in `worker/src/index.js:239-241`; plain noise in `worker/src/index.js:276-278` — none counted. `agent_runs` has no noise/invalid column (`d1/schema.sql:85-98`: `signals_seen, added, updated, briefs, ai_calls` only); health exposes no triage breakdown (`functions/api/[[path]].js:311`).
- Why it costs money/trust: the prompt says `DEFAULT TO NOISE` (`worker/src/index.js:213`) — correct bias, but with zero visibility nobody can tell a strict-but-right triage from a broken model dropping winners. Debugging is guesswork.
- Fix: without any migration, add `noise_last_run`/`noise_24h` to `/api/health` via `SELECT COUNT(*) FROM signals WHERE processed=1 AND opportunity_id IS NULL` (windowed by `created_at`), and show `+A/U · N noise` in the agent pill title and runs tab. Add an API test with seeded signals. Touch `functions/api/[[path]].js`, `public/app.js`, `functions/api/api.test.mjs`.
- Size: S. Risk: low (read-only counts from existing columns).

### F6 — Dashboard renders API failure as an empty board and never surfaces db-down

- Evidence: `refresh()` swallows every core fetch in `public/app.js:521-526` (`.catch(() => ({ opportunities: [] }))` etc.); empty ledger then claims `Nothing here. The next agent run may add some — or add one yourself.` (`public/app.js:82`); `renderRuns`/`agent-pill` read only the last run (`public/app.js:240-250`) and never `health.db`, so `db:"down"` has no UI.
- Why it costs trust: a D1 outage or detached binding presents as a fresh empty product, not an error — the operator adds rows or re-runs research instead of checking the binding.
- Fix: track per-fetch failures in `refresh()`, render a dismissible error banner naming the failed endpoint with a retry button, and turn the agent pill red with `db down` when `health.db !== "up"`. Touch `public/app.js`, `public/index.html`, `public/styles.css`.
- Size: S. Risk: low (presentation only; no fetch-path change).

### F7 — Opportunity ↔ experiment status disconnected: testing-without-test and test-without-testing both allowed

- Evidence: `updateOpportunity` accepts any status with no experiment check (`functions/api/[[path]].js:115-146`); `updateExperiment` never validates or syncs the parent status (`functions/api/[[path]].js:239-271`); the list already carries `experiment_count` (`functions/api/[[path]].js:54-56`) but the dashboard never cross-checks it.
- Why it costs money: the board can claim `testing` with zero experiments, or hide a `running` experiment under a `researching` parent — the money loop's state lies, and reviews waste time reconciling by hand.
- Fix: read-only warnings only (no auto-transitions): badge `testing · 0 experiments` on the ledger row and `running exp · opp still researching` on the board card, using the already-returned `experiment_count`/status fields. Touch `public/app.js` (optionally `public/styles.css` for the badge).
- Size: S. Risk: low (badges from existing fields; no API change).

### F8 — Auth mismatch + dead worker code invite the next incident

- Evidence: API constant-time compare (`functions/api/[[path]].js:21-29`) vs worker `!==` in three places (`worker/src/index.js:343-345,359-360,389-391` → `if (!want || got !== want) return json({ error: "unauthorized" }, 401);`, collapsing unset-token 503 into 401); `const BRIEF_DEADLINE_MS = 18000` never referenced (`worker/src/index.js:20` vs live `worker/src/index.js:174`); unused `scoreOf` import (`worker/src/index.js:139`); test-only `appendKeepNewest` (`worker/src/lib.js:36-39`, zero production callers); `GITHUB_QUERIES.slice(0,2)` drops `ai-side-project` (`worker/src/index.js:115` vs `:27`) with no comment.
- Why it costs trust/maintainability: timing side-channel on the worker token plus divergent 401/503 slows triage; the next editor tunes the wrong deadline constant or re-adds the dropped query as a bugfix.
- Fix: extract the constant-time compare into `worker/src/lib.js`, import it in both runtimes, align worker codes (503 unset / 401 mismatch); delete-or-wire `BRIEF_DEADLINE_MS`, drop `scoreOf` from the worker import, demote `appendKeepNewest` to a documented test oracle pointing at the SQL idiom, and comment the `slice(0,2)`. Touch `worker/src/lib.js`, `worker/src/index.js`, `functions/api/[[path]].js`, `worker/src/lib.test.js`.
- Size: S. Risk: low (auth tightens; keep tokens out of logs; `npm test` must stay green).

## 5. What NOT to change

- Scoring formula and honest seeds: `score = 100 * (value * confidence * fit) / (effort + 1)`, each input 1–10 (`README.md:56`; `worker/src/lib.js:15-16`). Do not retune weights without new evidence.
- Human-owns-status: "The agent never moves status." (`README.md:71`); "The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed)." (`worker/src/index.js:4-5`); "`researching → testing` is a human decision: flip to `testing` when you start a real experiment … The agent never moves status." (`README.md:71`). No auto-transitions.
- Killed-with-learning: "Killed strategies stay on the board with their post-mortem — that is the point." (`README.md:64`); "Closing an experiment as `won`/`lost` requires `result` + `post_mortem`; `ended_at` stamps automatically." (`README.md:73`). Do not purge killed rows or relax closure rules.
- Capped humility: "Agent proposals enter as `researching` with an `UNREVIEWED` marker in notes and an effective score capped to ≤6000 until a human vets them" (`README.md:65`); "A human admin vets each row: "Vet" clears the `UNREVIEWED` marker (keeps status, lifts the 6000 cap); "Kill" sets `killed` and requires a one-line post-mortem in notes." (`README.md:70`). Vet/kill stay human.
- Seed-vs-live accounting: "Seed runs once on an empty table; live count = 12 seeds + agent proposals + manual adds. Killed rows stay listed, so the count only grows." (`README.md:77`). Do not re-seed over live data; deploy's seed-if-empty (`deploy/deploy.sh:30-42`) stays.
- Auth split and secrets: "Reads are public. Writes require `Authorization: Bearer <ADMIN_TOKEN>`." (`functions/api/[[path]].js:1-2`); "`ADMIN_TOKEN` lives in two places: the Pages env var and the worker secret … No expiry; rotate manually when shared or leaked." (`README.md:81-82`). Anything needing `ADMIN_TOKEN`, `CLOUDFLARE_API_TOKEN`, D1 execute, or wrangler deploy is operator-owned and credential-gated — out of scope for code edits.
- Anything needing a login, payment, or human judgment: vetting `UNREVIEWED` rows, moving `researching → testing → scaling`, writing post-mortems, choosing niches/pricing/outreach, rotating tokens. This audit proposes surfacing and guardrails only — never auto-vetting, auto-scaling, or auto-spend.

## 6. Proposed next tasks (2–4)

### Task 1: Show decisions/week and vetted-to-experiment rate on health and board

- Owned files: `functions/api/[[path]].js`, `public/app.js`, `public/index.html`, `functions/api/api.test.mjs`.
- Acceptance: (a) `/api/health` returns `decisions_last_7d` and `vetted_last_7d` from existing columns (no migration) with new API tests green; (b) Experiments header shows `X decisions this week · Y vetted → Z experiments`; (c) existing health keys unchanged so `verify.sh` stays green; (d) `npm test` green.

### Task 2: Disclose manual-triage-only runs; brief oldest-unreviewed when backlog old

- Owned files: `worker/src/index.js`, `public/app.js`, `public/index.html`.
- Acceptance: (a) button reads triage-only and `/run` 202 includes `briefs_skipped:true` with reason; (b) cron ticks brief one extra oldest-unreviewed bare row when backlog age > 48h (stays within `MAX_AI_CALLS=4`); (c) toast/log copy states where briefs land; (d) `npm test` green.

### Task 3: Show API-failure banner and testing-without-experiment warnings

- Owned files: `public/app.js`, `public/index.html`, `public/styles.css`.
- Acceptance: (a) any failed core fetch renders a named error banner with retry instead of `Nothing here`; (b) `health.db != "up"` turns the agent pill red with `db down`; (c) ledger badges `testing · 0 experiments` and board badges `running exp · opp still researching` appear from existing fields; (d) `npm test` green; (e) no auto-transitions added.
