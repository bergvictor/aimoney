# AUDIT-2026-09-20-round1 — aimoney

Clone: `/mnt/c/coding-projects/_workspace/night-aimoney` (read-only; no writes except this file).
Live snapshots read: `_night/live/aimoney_pages_dev.html` (4953 bytes, HTTP 200), `_night/live/aimoney_pages_dev_api_health.html` (198 bytes, HTTP 200).
No `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING` in clone; `README.md` + `docs/AUDIT-2026-09-20.md` used as governing docs. `.env`/secrets never read.

## 1. What this project is and how it runs

- Purpose: Cloudflare-native AIMoney Lab — ranked AI-money opportunities with scores, research briefs, experiments, and a cron research agent.
- Entry points: dashboard `public/index.html` + `public/app.js`; API `functions/api/[[path]].js`; agent `worker/src/index.js` + `worker/src/lib.js`; DB `d1/schema.sql`.
- Live surfaces: `https://aimoney.pages.dev`, `https://aimoney.pages.dev/api/health`, worker `https://aimoney-research.<account>.workers.dev`.
- Scheduled jobs: worker cron `0 */6 * * *` (`worker/wrangler.toml:9`) — collect signals, AI triage, 1 brief per tick, log to `agent_runs`.
- How it deploys: `./deploy/deploy.sh` (D1 schema + seed-if-empty, stamp `public/release.json`, Pages deploy, worker deploy); Pages Git-connected rebuild + `.github/workflows/deploy-worker.yml` on `worker/**` push; `./deploy/verify.sh` checks markers + freshness.

## 2. End-to-end walk-through

Main loop: signal found → agent proposal → human vet → experiment → close with learning → rescore.

1. Cron/manual triggers pass: `worker/src/index.js:332-333` (`scheduled` → `runResearch(env,"cron")`) and `worker/src/index.js:388-396` (`POST /run` → `waitUntil(runResearch(env,"manual"))`).
2. Collect signals in parallel: `worker/src/index.js:176` (`Promise.allSettled([hnSignals(), redditSignals(), githubSignals()])`); sources `worker/src/index.js:47-69` (HN ×4 queries), `worker/src/index.js:71-93` (Reddit ×3), `worker/src/index.js:95-116` (GitHub, `slice(0,2)` of 3 queries); fetch helper `worker/src/index.js:35-45` (`timedJson`, 6s abort covering body read).
3. Batch-insert signals + heartbeat: `worker/src/index.js:181-186` (`INSERT OR IGNORE INTO signals`, one `DB.batch`); `worker/src/index.js:187-191` (`phase:collected/classify-ai/...` heartbeat); reap stuck runs `worker/src/index.js:145-150` (`status='running'` older than 30 min → `error`).
4. Classify fresh signals vs live list: `worker/src/index.js:192-194` (`SELECT * FROM signals WHERE processed=0 LIMIT 6`); `worker/src/index.js:201-203` (top-60 opps); `worker/src/index.js:217-221` (`aiComplete` Mistral NDJSON); parse `worker/src/lib.js:49-64` (`parseJsonLines`, first-`{...}`-per-line + `repairJson` for `\_`).
5. Apply verdicts: new → `worker/src/index.js:242-266` (`INSERT INTO opportunities ... status="researching"`, `effectiveScore({...,"UNREVIEWED"})`, notes carry `UNREVIEWED`); supports → `worker/src/index.js:267-275` (`substr(notes || ?,-8000)`, newest kept); noise/invalid → `worker/src/index.js:276-278` / `worker/src/index.js:232-235` (marked `processed=1`).
6. Brief one bare opp (cron only): `worker/src/index.js:283-285` (`LEFT JOIN briefs ... WHERE b.id IS NULL ORDER BY o.score DESC LIMIT 1`, skipped when `Date.now()-t0 >= briefDeadline`); `worker/src/index.js:291-303` (Llama brief JSON); `worker/src/index.js:310-318` (`INSERT INTO briefs`, skipped if `summary`/`first_steps` empty).
7. Finish run: `worker/src/index.js:161-167` (`UPDATE agent_runs SET finished_at,status,signals_seen,added,updated,briefs,ai_calls,error`).
8. Board reads: `public/app.js:494-510` (`refresh()` loads `/api/opportunities?limit=200`, `/api/experiments`, `/api/runs?limit=20`, `/api/health`, `/api/meta`); list `functions/api/[[path]].js:39-66` (`unreviewed=1` filter, `oldest` sort, `effectiveScore` cap, re-sort by effective score); review view `public/app.js:87-126` + `public/app.js:170-184` (Needs-review chip).
9. Human vets: `public/app.js:132-148` (Vet strips `UNREVIEWED`, lifts cap) / `public/app.js:150-168` (Kill sets `killed` + post-mortem prompt) → `functions/api/[[path]].js:115-146` (`PATCH /api/opportunities/:id`, rescore via shared `effectiveScore`).
10. Experiment loop: log/update `public/app.js:423-468` (`openExperimentModal`) → `functions/api/[[path]].js:199-216` (create) / `functions/api/[[path]].js:218-250` (update: `running` stamps `started_at`, `won`/`lost` require `result`+`post_mortem` and stamp `ended_at`, invalid status 400); detail drawer `public/app.js:255-297` + admin re-optimize `public/app.js:307-352`.
11. Health/verify: `functions/api/[[path]].js:265-285` (`/api/health`: `rev,db,opportunities,unreviewed,bare_without_brief,experiments_by_status,hours_since_last_ok_run,time`); `deploy/verify.sh:28-58` (7 markers + non-empty list + freshness ≤12h).

Where it most often breaks or goes silent: the human bottleneck after hop 5. Live health proves it: `unreviewed:11/27` (41%), `bare_without_brief:19/27` (70%), `experiments_by_status:{"planned":2}` with zero `running`/`won`/`lost`. Briefing does 1/tick (`worker/src/index.js:283-285`) while proposals append every run, so the queue grows faster than vetting; status moves are manual-only (`worker/src/index.js:4-5`, `README.md:71`), so `planned` rows sit with no stale-nudge and no experiment→score feedback. Secondary silent spots: invalid verdicts marked `processed=1` and dropped (`worker/src/index.js:232-235`); manual runs never brief (`briefDeadline=-1`, `worker/src/index.js:174`); dashboard `api().catch(()=>({}))` (`public/app.js:495-499`) renders empty sections instead of errors.

## 3. Health signals measured here

- Test suite (`npm test` = `node --test worker/src/lib.test.js functions/api/api.test.mjs public/tab-icon.test.mjs`): PASS, 27/27, 11 suites, 0 fail. Real tail: `# tests 27 / # suites 11 / # pass 27 / # fail 0 / # duration_ms 215.035707`. Baseline quoted in brief (Windows, 185.1113 ms) is same order; this Linux run is ~215 ms. Warnings only: `UNDICI-EHPA` proxy-agent notice and `MODULE_TYPELESS_PACKAGE_JSON` reparsing hint for `[[path]].js`/`lib.test.js` (add `"type":"module"` to silence; no behavior change).
- Syntax checks (no writes): `node --check public/app.js` → exit 0; `node --check worker/src/index.js` → exit 0; `node --check worker/src/lib.js` → exit 0; `node --check functions/api/api.test.mjs` → exit 0 (each with only the `UNDICI-EHPA` warning). `node --check` on `functions/api/[[path]].js` was approval-aborted by the bracketed path; the file is exercised green by `npm test` instead.
- `python3 -m compileall -q`: NOT RUN — no Python sources in repo (glob `**/*.py` returns zero files) and `compileall` would write `__pycache__` into this read-only clone. JS equivalent above is the real syntax signal.
- Dead code (inspected, not guessed): `worker/src/index.js:20` defines `const BRIEF_DEADLINE_MS = 18000` but the pass uses `worker/src/index.js:174` (`trigger==="cron" ? 300000 : -1`) — the constant is never referenced. `worker/src/index.js:139` imports `scoreOf` but the file only calls `effectiveScore/clamp10/slugify/parseJsonLines/repairJson`. `worker/src/lib.js:36-39` exports `appendKeepNewest` yet production uses SQL `substr(notes || ?,-8000)` (`worker/src/index.js:271-275`); the helper is test-only. `worker/src/index.js:115` (`GITHUB_QUERIES.slice(0,2)`) silently drops the third query (`ai-side-project`, `worker/src/index.js:27`).
- Duplicated logic: `clamp10` exists twice — `functions/api/[[path]].js:12-16` (Number→round? no: `Math.min(10,Math.max(1,Math.round(n)))` via `Number(v)`) vs `worker/src/lib.js:4-7` (`Math.round(Number(v))`, same bounds, different non-finite handling). `scoreOf`/`effectiveScore` are now correctly shared (`functions/api/[[path]].js:10` imports from `worker/src/lib.js`; `worker/src/index.js:139` same source; cross-boundary test `functions/api/api.test.mjs:163-174` locks agreement). Auth compare is duplicated with divergent semantics: constant-time loop in API (`functions/api/[[path]].js:21-29`) vs `!==` in worker (`worker/src/index.js:343-345,359-360,389-391`). Review-action markup (`Vet`/`Kill` buttons) is inline in `public/app.js:95-98` with no shared component, but used once — not counted as harmful duplication.
- TODO density: 0. Regex search for `TODO|FIXME|XXX|HACK|TBD` across repo returns zero matches. No `console.log`/`debugger` in shipped `public/app.js` (verified by read).
- Live snapshot (read-only, from `_night/live/`): dashboard HTML matches repo `public/index.html` (title `AIMoney Lab — ranked ways to make money with AI`, favicon link + `theme-color #0d6b3f` present, no dark-mode branch, no inline header SVG — see findings). Health JSON: `{"ok":true,"rev":"b92e2eb","db":"up","opportunities":27,"unreviewed":11,"bare_without_brief":19,"experiments_by_status":{"planned":2},"hours_since_last_ok_run":2.9,"time":"2026-09-20T02:56:38.237Z"}` — fresh run (2.9h), but 41% unreviewed, 70% bare, zero running/won/lost experiments.

## 4. Ranked findings (max 8)

### F1 — Experiments stall in `planned`; the money step never moves

- Evidence: `_night/live/aimoney_pages_dev_api_health.html:1` → `"experiments_by_status":{"planned":2}` (no `running`/`won`/`lost`); seed still `planned` in `d1/seed.sql:67-71` (`'Spec-ad sprint: 10 brands, 10 free ads', ... 'planned'`); status moves are manual drawer edits only (`public/app.js:307-352` admin zone; `public/app.js:423-468` modal) and the agent is forbidden from moving status (`worker/src/index.js:4-5` → `// The agent PROPOSES; the human ... (it never moves status to testing/scaling/killed).`).
- Why it costs money: the board ranks but never converts rank into measured spend/revenue; `planned` rows with real-world artifacts (prior audit cites a 31-brand pack + proof site shipped elsewhere) sit while the loop reports green. No stale-`planned`/`running` nudge exists, so drift is silent.
- Fix: add a read-only staleness surface, not auto-transitions (human-owns-status stays). In `functions/api/[[path]].js` extend health or add `days_in_status` to experiment list; in `public/app.js`/`public/index.html` show an age chip (e.g. `planned 21d`) and sort stale first; in `deploy/verify.sh` warn when any `planned`/`running` exceeds N days. Touch `functions/api/[[path]].js`, `public/app.js`, `public/index.html`, optionally `deploy/verify.sh`.
- Size: M. Risk: low (read-only surfacing; no status auto-move, no schema change required).

### F2 — Review queue + bare-brief backlog outruns vetting; capped scores hide signal

- Evidence: health `unreviewed:11`, `bare_without_brief:19` of 27 opps (`_night/live/aimoney_pages_dev_api_health.html:1`); briefing is one row per cron tick in `worker/src/index.js:283-285` → `` `SELECT o.* FROM opportunities o LEFT JOIN briefs b ON b.opportunity_id = o.id WHERE b.id IS NULL ORDER BY o.score DESC LIMIT 1` ``; new proposals cap to ≤6000 via `worker/src/lib.js:29-32` (`effectiveScore`) so unvetted rows pile below the fold.
- Why it costs money/users/trust: at 19 bare and 1 brief/tick every 6h, best case is ~5 days to cover the backlog even with zero new proposals — but every run can add more. Good ideas stay capped and unbriefed; the "Needs review (N)" chip (`public/index.html:49`, `public/app.js:119-126`) counts but never ages or prioritizes.
- Fix: make the backlog visible and bounded. Add `oldest_unreviewed_age_h` and `bare_list` (ids + scores) to `/api/health` in `functions/api/[[path]].js`; show age on the review chip and sort review view oldest-first by default (already supported via `?unreviewed=1&sort=oldest`); consider briefing the highest-effective-score bare row per tick (already the query) plus one oldest-unreviewed row when backlog age exceeds 48h. Touch `functions/api/[[path]].js`, `public/app.js`, `functions/api/api.test.mjs`.
- Size: M. Risk: low-medium (health shape addition; keep existing keys stable for `verify.sh`).

### F3 — Header lacks the inline brand mark (standing rule 3)

- Evidence: `public/index.html:16` → `<p class="brand">AIMoney Lab</p>` (text only, no SVG); `public/styles.css:36-39` styles `.brand` as mono uppercase text; no `<svg` in `public/index.html` (search for `svg` hits only the favicon link). Favicon is `public/favicon.svg:1` (32×32, `#0d6b3f` rounded square, `$` glyph, 285 bytes) — the tab shows a mark the page header does not repeat.
- Why it costs trust: tab and page do not match; the page looks unbranded/generic on first paint, exactly what the owner rule targets. Live snapshot confirms the same gap.
- Fix: inline a small SVG next to the site name in `public/index.html` reusing the favicon geometry (rounded square `#0d6b3f` + `$`, no external fonts), styled in `public/styles.css` to align with `.brand`; keep it under ~500 bytes and aria-hidden. Touch `public/index.html`, `public/styles.css`.
- Size: S. Risk: negligible (static markup + CSS; snapshot-testable).

### F4 — Guard test locks the icon but not light-mode or the brand mark (standing rule 4)

- Evidence: `public/tab-icon.test.mjs:62-76` asserts `rel="icon"` + `href="/favicon.svg"` + `name="theme-color"` only; no assertion against `prefers-color-scheme`, `data-theme`, theme toggles, or for the header brand SVG. `public/styles.css` currently passes (light palette `--paper:#ffffff`, no dark branch — verified zero hits for `prefers-color-scheme|data-theme|color-scheme`), but a future dark-mode edit would stay green.
- Why it costs trust: rules 1 and 3 can regress silently; the test suite would still report 27/27. The missing `color-scheme: light` declaration (zero hits repo-wide) also means form controls/dialog could follow OS dark mode even though the palette is light.
- Fix: extend `public/tab-icon.test.mjs` with two assertions: (a) served HTML/CSS contain no `prefers-color-scheme`, `data-theme`, or theme-toggle hooks and CSS declares `color-scheme: light`; (b) `public/index.html` contains the inline header brand SVG (same accent + glyph as `favicon.svg`). Add `color-scheme: light` to `:root` in `public/styles.css`. Touch `public/tab-icon.test.mjs`, `public/styles.css`, `public/index.html`.
- Size: S. Risk: negligible (test-only + one CSS declaration).

### F5 — Experiment list hides orphans via inner join

- Evidence: `functions/api/[[path]].js:190-195` → `SELECT e.*, o.title ... FROM experiments e JOIN opportunities o ON o.id = e.opportunity_id` (inner `JOIN`, not `LEFT JOIN`); schema FKs are advisory (`d1/schema.sql:50` → `opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE` with no `PRAGMA foreign_keys`), so a deleted opp can strand or hide its experiments instead of surfacing an orphan badge.
- Why it costs money/trust: a running experiment whose opportunity is deleted vanishes from the board instead of alerting; spend/result history silently disappears from the money view.
- Fix: switch to `LEFT JOIN` and coalesce missing opp fields to an `orphaned:true` flag; render an "orphaned" pill in `public/app.js` board/drawer; add an API test in `functions/api/api.test.mjs` with a dangling `opportunity_id` asserting the row still returns. Touch `functions/api/[[path]].js`, `public/app.js`, `functions/api/api.test.mjs`.
- Size: S. Risk: low (list-shape addition; existing consumers ignore the new flag).

### F6 — Manual "Run research now" never briefs and shares the 30s cap

- Evidence: `worker/src/index.js:174` → `const briefDeadline = trigger === "cron" ? 300000 : -1;` combined with `worker/src/index.js:283` (`Date.now()-t0 < briefDeadline`) means manual passes always skip the brief phase; `worker/src/index.js:388-396` runs manual in `waitUntil` like cron despite the header comment `worker/src/index.js:7-11` claiming cron gets longer; dashboard dead-ends when unset in `public/app.js:473-475` (`if (!worker) return toast("Worker URL not configured (RESEARCH_WORKER_URL).")`).
- Why it costs users/trust: clicking "Run research now" does half a pass with no visible disclosure (toast says `Research pass started — watch the Research log tab`, `public/app.js:485`); operators expect a brief and get none, then re-click and burn AI budget.
- Fix: disclose the split in UI and API: label the button "Run triage now (briefs on cron)" in `public/index.html`/`public/app.js`, include `briefs_skipped:true, reason:"manual skips brief pass"` in the `/run` 202 response and the finished `agent_runs.error`/`notes` in `worker/src/index.js`, and surface `writes_enabled`/`worker_url` from `/api/meta` as a disabled-with-reason button state. Touch `public/index.html`, `public/app.js`, `worker/src/index.js`.
- Size: S. Risk: low (copy + response-field addition; no scheduling change).

### F7 — Auth compare differs between API and worker

- Evidence: API constant-time in `functions/api/[[path]].js:21-29` (`for (...) diff |= want.charCodeAt(i) ^ got.charCodeAt(i)`); worker uses `!==` in three places (`worker/src/index.js:345`, `worker/src/index.js:360`, `worker/src/index.js:391` → `if (!want || got !== want) return json({ error: "unauthorized" }, 401);`). API distinguishes `503 writes disabled` vs `401 bad token` (`functions/api/[[path]].js:83`); worker collapses both to `401`.
- Why it costs trust: timing side-channel on the worker token plus inconsistent operator signals (same misconfiguration yields different codes on Pages vs worker), slowing incident triage.
- Fix: extract the constant-time compare into `worker/src/lib.js` (pure, unit-testable), import it in both `worker/src/index.js` and `functions/api/[[path]].js`, and align worker responses (`503` when `ADMIN_TOKEN` unset, `401` on mismatch). Add `worker/src/lib.test.js` cases for length-mismatch and timing-shape. Touch `worker/src/lib.js`, `worker/src/index.js`, `functions/api/[[path]].js`, `worker/src/lib.test.js`.
- Size: S. Risk: low (auth semantics tighten; keep token values out of logs; verify Pages + worker with existing tests).

### F8 — Dead constant + unused import + test-only helper invite drift

- Evidence: `worker/src/index.js:20` (`const BRIEF_DEADLINE_MS = 18000; ...`) never referenced (only use is `briefDeadline`, `worker/src/index.js:174`); `worker/src/index.js:139` imports `scoreOf` unused; `worker/src/lib.js:36-39` (`appendKeepNewest`) has tests (`worker/src/lib.test.js:89-102`) but zero production callers; `worker/src/index.js:27` lists 3 GitHub queries but `worker/src/index.js:115` runs `slice(0,2)`.
- Why it costs money/maintainability: the next editor will tune the wrong constant (`BRIEF_DEADLINE_MS`) and wonder why briefs never shift; the SQL-vs-helper split (`substr(...,-8000)` vs `appendKeepNewest`) can drift silently; the dropped GitHub query looks like a bug or a quota hack with no comment.
- Fix: delete `BRIEF_DEADLINE_MS` or wire it as the cron deadline with a comment; drop `scoreOf` from the worker import (keep `effectiveScore`); either call `appendKeepNewest` from a single JS-side notes path or demote it to a documented test oracle with a comment pointing at the SQL; add a one-line comment on the GitHub `slice(0,2)` (rate-limit vs forgotten). Touch `worker/src/index.js`, `worker/src/lib.js`.
- Size: S. Risk: negligible (no behavior change if done as cleanup + comments).

## 5. What NOT to change

- Scoring formula and honest seeds: `score = 100 * (value * confidence * fit) / (effort + 1)`, each input 1–10 (`README.md:56`; `worker/src/lib.js:15-16`). The 12 seed scores recompute exactly; do not retune values or weights without new evidence.
- Human-owns-status: "The agent never moves status." (`README.md:71`); "The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed)." (`worker/src/index.js:4-5`); "`researching → testing` is a human decision: flip to `testing` when you start a real experiment ... The agent never moves status." (`README.md:71`). Do not add auto-transitions.
- Killed-with-learning: "Killed strategies stay on the board with their post-mortem — that is the point." (`README.md:64`); "Closing an experiment as `won`/`lost` requires `result` + `post_mortem`; `ended_at` stamps automatically." (`README.md:72`). Do not purge killed rows or relax closure rules.
- Capped humility for proposals: "Agent proposals enter as `researching` with an `UNREVIEWED` marker in notes and an effective score capped to ≤6000 until a human vets them" (`README.md:65`); "A human admin vets each row: "Vet" clears the `UNREVIEWED` marker (keeps status, lifts the 6000 cap); "Kill" sets `killed` and requires a one-line post-mortem in notes." (`README.md:70`). Vet/kill stay human.
- Seed-vs-live accounting: "Seed runs once on an empty table; live count = 12 seeds + agent proposals + manual adds. Killed rows stay listed, so the count only grows." (`README.md:76`). Do not re-seed over live data; deploy's seed-if-empty (`deploy/deploy.sh:30-42`) stays.
- Auth split and secrets: "Reads are public. Writes require `Authorization: Bearer <ADMIN_TOKEN>`." (`functions/api/[[path]].js:1-2`); "`ADMIN_TOKEN` lives in two places: the Pages env var and the worker secret ... No expiry; rotate manually when shared or leaked." (`README.md:80-81`). Anything needing `ADMIN_TOKEN`, `CLOUDFLARE_API_TOKEN`, D1 execute, or wrangler deploy is out of scope for code edits — operator-owned, credential-gated.
- Anything needing a login, payment, or human judgment: vetting `UNREVIEWED` rows, moving `researching → testing → scaling`, writing post-mortems, choosing niches/pricing/outreach, and rotating tokens. This audit proposes surfacing and guardrails only, never auto-vetting, auto-scaling, or auto-spend.

## 6. Proposed next tasks (2–4)

### Task 1: Show stale experiment age + backlog age on board and health (read-only)

- Owned files: `functions/api/[[path]].js`, `public/app.js`, `public/index.html`, `functions/api/api.test.mjs`.
- Acceptance: (a) `/api/experiments` includes `days_in_status` (or health reports `stale_planned`/`stale_running` counts) with a new API test green; (b) Experiments board shows `planned Nd`/`running Nd` chips sorted stale-first; (c) review chip shows oldest-unreviewed age (e.g. `Needs review (11 · oldest 3d)`); (d) `npm test` 27+/27+ green; (e) no status auto-move — human flips only.

### Task 2: Add inline header brand mark; lock icon, light mode, mark in tests

- Owned files: `public/index.html`, `public/styles.css`, `public/tab-icon.test.mjs`.
- Acceptance: (a) header shows inline SVG (accent `#0d6b3f`, `$` glyph, no external fonts) next to `AIMoney Lab`; (b) CSS declares `color-scheme: light` with zero `prefers-color-scheme`/`data-theme`/toggle hooks; (c) extended `tab-icon` test fails if icon link, `theme-color`, brand SVG, or light-mode lock is removed; (d) `npm test` green; (e) live snapshot re-check shows tab and header marks matching.

### Task 3: Fix experiment list to LEFT JOIN orphans with badge + test

- Owned files: `functions/api/[[path]].js`, `public/app.js`, `functions/api/api.test.mjs`.
- Acceptance: (a) `listExperiments` uses `LEFT JOIN` and returns dangling rows with `orphaned:true` (new test with bogus `opportunity_id` green); (b) board/drawer renders an `orphaned` pill instead of dropping the card; (c) `npm test` green; (d) no migration — query-only change.
