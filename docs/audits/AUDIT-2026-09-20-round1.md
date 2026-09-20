# AUDIT 2026-09-20 — aimoney (round 1, overnight lane)

Clone HEAD: `d1aa266` ("Night round 3 (aimoney): vet starter, win source, nudge deep-link"). Live rev (`_night/live/aimoney_pages_dev_api_health.html`): `d1aa266` — live EQUALS HEAD this round (round-3 F1 resolved; Win, inflow cap, revenue source are all live).
Lane metric right now (live payload, measured 2026-09-20T23:19Z): **0 decisions/week, 0 vetted/week, $0.00 revenue/week, $0.00 lifetime, 11 unreviewed (oldest 167h ≈ 7.0d), 19/27 rows without a brief, 2 planned / 0 running experiments, last ok run 5.3h ago**.
No repo-local `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING.md` (glob search empty); governed by `README.md` plus the session standing rules.
Surfaces judgment: `_night/live/aimoney_pages_dev.html` is line-identical to `public/index.html` on full read (121 lines each, same content). Light palette only (`public/styles.css:4` `color-scheme: light`; no `prefers-color-scheme: dark`, no `data-theme`, no theme toggle in served CSS/JS/HTML), favicon + `theme-color` (`public/index.html:9-10`, `public/favicon.svg` one line, ~285 bytes), inline brand mark matching the favicon accent and `$` glyph (`public/index.html:16`), guard suite green (`public/tab-icon.test.mjs`). **Zero surface-rule findings this round.**

## 1. What this project is and how it runs

- Purpose: AIMoney Lab — a ranked board of AI-money opportunities with evidence briefs and experiments (`README.md:1-15`).
- Entry points: dashboard `public/index.html` + `public/app.js`; API `functions/api/[[path]].js`; agent `worker/src/index.js` + `worker/src/lib.js`.
- Live surfaces: `https://aimoney.pages.dev`, `/api/health`, research worker (`README.md:27-31`, `deploy/public-surfaces.json`).
- Scheduled jobs: worker cron every 6h (`worker/wrangler.toml:8-9`); manual triage-only `POST /run` 202 with `briefs_skipped:true` (`worker/src/index.js:540-548`).
- Deploys: `./deploy/deploy.sh` (idempotent schema + additive migrations, seed-if-empty, stamp `release.json`, Pages + worker), `./deploy/verify.sh` gates rollout (≤12h freshness); Pages auto-redeploys on push, worker via `.github/workflows`.

## 2. End-to-end walk-through

Signal → triage → proposal → brief → vet → experiment → close → money:

1. Collect: cron tick → `runResearch(env,"cron")` (`worker/src/index.js:182` via `scheduled` at `:484-485`) fans out HN/Reddit/GitHub (`:217`, `:48`, `:72`, `:96`), one batched `INSERT OR IGNORE` (`:222-227`). Source hiccups are swallowed per-source (`catch {}` at `:66`, `:90`, `:113`) — a dead source shows only as a lower `signals_seen`, never by name.
2. Sweep + take: 30d-stale signals → noise with count (`:235-240`); oldest 6 unprocessed taken (`:242-244`); exact-URL matches link as supports before triage, no AI call (`:250-267` via pure `exactUrlTarget`, `:153-163`). Quiet ticks continue to the brief pass (`:268-271`).
3. Triage: one Mistral NDJSON call over top-60 list + fresh signals (`:274-294`; budget `MAX_AI_CALLS=4`, `:17`); `parseJsonLines` (`worker/src/lib.js:49-64`); strict validation (`worker/src/index.js:296-315`); `new` inserts a `researching` + `UNREVIEWED` row with humility clamp (`:322-323`) and capped score (`:335`), at most 2 per run with overflow left unprocessed (`:317`); slug collision links as supports (`:343-355`); `supports` appends `[signal date]` evidence newest-kept (`:356-364`); else noise (`:365-367`).
4. Brief: cron only (`briefDeadline`, `:215`; manual `POST /run` always skips, `:548`); oldest-unreviewed-first past 48h (`:374-388`), else top-scored (`:386-388`); one Llama call (`:389-406`); empty/malformed JSON skipped silently with no marker (`:407-423`); one extra oldest bare row past 48h (`:429-473`); run closed with a redundant double `finish("ok")` (`:474-475`).
5. Serve: `GET /api/opportunities` with review queue `?unreviewed=1&sort=oldest` (`functions/api/[[path]].js:42-71`, capped `:66-69`); detail + briefs + experiments (`:73-84`); health counters incl. `decisions_last_7d`/`vetted_last_7d`/`revenue_last_7d`/`revenue_total` (`:355-391`); `GET /api/meta` (`:393-399`).
6. Decide (all human): boot `refresh()` (`public/app.js:1118-1137`) loads list + experiments + runs + health + meta + review list; review rows carry capital + next action + source + brief summary with inline Vet / Vet-&-starter / Kill (`:164-222`); Vet clears the marker and appends `[date vetted]`, toast offers Log experiment (`:377-395`); Vet-&-starter composes vet + planned POST + flip to testing with a Start shortcut (`:403-433`); Kill takes an inline post-mortem line (`:435-459`); Start-here strip shows Vet/Kill for unreviewed top picks (`:95-130`); drawer + admin zone for rescore/status (`:709-756`, `:781-878`).
7. Experiment: modal log with dollar→cents conversion (`:976-1027`); board one-click Start (`:520-532`, button `:629`), one-click Lose (`:539-556`) and one-click Win with inline $ + source + line (`:565-582`, buttons `:630`); API create (`functions/api/[[path]].js:236-285`) and update (`:287-340`) enforce result + post-mortem on close (`:310-314`), stamp `started_at`/`ended_at` (`:309,:315`), append a `[$X rev / $Y spent via {source}]` outcome line to the parent (`:320-329`); drawer suggests a ±1 rescore, never auto-applied (`public/app.js:769-779`); zero-decision weeks get a read-only stale nudge that deep-links to the board card with its own Start when planned (`:506-513`, `:609-618`).
8. Where it most often breaks or goes silent, in order: **(a)** the human funnel — 2 planned experiments wait for one press while decisions sit at 0 and the oldest unreviewed row ages to 7.0d; **(b)** a poison bare row burns one Llama call per cron tick forever with no marker (F1); **(c)** every dashboard tap re-reads the whole list twice (F2) plus a detail refetch for an already-loaded line (F3); **(d)** collect takes up to ~72 signals/run while triage drains 6, with no DELETE anywhere, so unread rows pile until the 30d sweep noises them (F6); **(e)** agent evidence appends move the human `vetted_last_7d` counter (F8).

## 3. Health signals measured here

- `npm test` (Windows baseline `_night/tests-baseline.log`, exit 0): **190 pass / 0 fail, 67 suites, duration_ms 290.5752**. Linux rerun here: **exit 0** (only warnings are the known `MODULE_TYPELESS_PACKAGE_JSON` reparsing notes and sandbox proxy notes; TAP capture truncated at 40KB, zero `not ok` lines in the visible portion, suites 1–48+ all `ok` — same suites as baseline).
- `node --check`: exit 0 on `public/app.js`, `worker/src/index.js`, `worker/src/lib.js`. The API router check was refused by the shell-approval adapter (it aborts on the `[[path]]` glob chars); its parse is proven by the green suite, which imports it (`functions/api/api.test.mjs:6`, 20 API suites green).
- `python3 -m compileall`: N/A — repo contains zero `*.py` files (glob `**/*.py` search returned nothing; JS-only: Pages + Functions + Worker, `node --test` suites).
- TODO density: **0** — regex search for `TODO|FIXME|XXX|HACK` across `public/`, `functions/`, `worker/`, `scripts/`, `deploy/`, `d1/` returns nothing. No `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING` files (glob search empty).
- Dead code (all verified present): redundant double `await finish("ok")` (`worker/src/index.js:474-475`); `BRIEF_DEADLINE_MS` defined but never referenced (`:21` vs live `briefDeadline` at `:215`); unused `scoreOf` import (`:140`, zero call sites in file); `GITHUB_QUERIES.slice(0, 2)` silently drops the third query (`:116` vs `:28`); five dead toast gates after modal returns (`public/app.js:380,438,523,542,568`, each self-commented as superseded); `appendKeepNewest` has zero production callers (`worker/src/lib.js:36-39`, tests only).
- Duplicated logic: oldest-unreviewed age query runs twice per old-backlog cron tick (`worker/src/index.js:377-378` and `:430-433`); `clamp10` in the API (`functions/api/[[path]].js:12-16`) vs `worker/src/lib.js:4-7` (near-identical, not shared); classify prompt text duplicated between the pass (`worker/src/index.js:277-287`) and `/debug-classify` (`:519-528`); brief-prompt + brief-insert duplicated for main (`:393-420`) and extra (`:444-469`) briefs; `UNREVIEWED` appears as SQL/string literals (`functions/api/[[path]].js:52,357,361`; `worker/src/index.js:335,338,377,384,431,437`) while the exported `UNREVIEWED_MARKER` (`worker/src/lib.js:21`) is used only inside lib; the vetted tag is string-coupled (`[date vetted]` written at `public/app.js:384`, counted via `LIKE '%vetted]%'` at `functions/api/[[path]].js:369-370`); worker token compare repeated 3x (`worker/src/index.js:495-497,510-512,541-543`) vs the API constant-time compare (`functions/api/[[path]].js:24-32`).
- Live health (`_night/live/aimoney_pages_dev_api_health.html`, 362 bytes): `{"ok":true,"rev":"d1aa266","db":"up","opportunities":27,"unreviewed":11,"bare_without_brief":19,"experiments_by_status":{"planned":2},"hours_since_last_ok_run":5.3,"oldest_unreviewed_age_h":167,"decisions_last_7d":0,"revenue_last_7d":0,"revenue_total":0,"spent_total":0,"vetted_last_7d":0,"vetted_no_experiment":0,"noise_24h":0}`. Worker fresh (5.3h); every decision and money counter is zero; live rev equals HEAD.
- Note on acceptance: I created only this file and edited nothing. Shell policy denied piped commands and `/tmp` script execution, so the `npm test` total above is the runner's Windows baseline plus my exit-0 Linux rerun, and byte-count diffs were replaced by full-content reads.

## 4. Ranked findings (max 8)

Money first, in numbers from the repo's own data (live health payload + seed):

1. Money produced to date: **$0.00 lifetime, $0.00 in the last 7d** (`revenue_total:0`, `revenue_last_7d:0`) — none. No krone has ever arrived; no experiment has ever closed (`experiments_by_status` holds only `planned:2`).
2. The single step between the current state and the next payment: **a human presses Start on one of the 2 planned experiments** — concretely the $0 `Spec-ad sprint: 10 brands, 10 free ads` (`d1/seed.sql:67-71`, budget `$0 + 10 hours`, target `>=1 pilot at >=$500`). Everything after that (replies, pilot, close-as-won with amount + source) exists in the code already.
3. Measured conversion at that step right now: **0 starts out of 2 planned, 0 decisions in the last 7d, 0 vetted in the last 7d** — 0 attempts, 0 successes over the 7-day health window (oldest unreviewed row 167h ≈ 7.0d).

The bottleneck is outside the code: nothing can pay until a human presses Start, and no code change can press it. The findings below therefore cut waste and quiet failure so that when the human acts, nothing stale, duplicated, or silently broken stands in the way. No surface-rule findings: the served page is light-only with icon, brand mark, and a guard test (see §3).

**F1 — A failed brief burns one Llama call per cron tick on the same row, forever, with no marker.**
Evidence: the bare pick is deterministic — `SELECT o.* ... WHERE b.id IS NULL ORDER BY o.score DESC LIMIT 1` (`worker/src/index.js:386-388`, oldest-first variant at `:384`) — while a malformed or keyless brief is swallowed: `} catch { /* malformed brief JSON: skip, briefs stay human-seeded */ }` (`:423`) and the empty-brief guard at `:412` records nothing; the extra-brief pass repeats the pattern (`:456-470`, `catch { /* extra brief is best-effort; lands next run */ }` at `:470`). A poison row keeps its score, stays bare, and is re-picked next tick, spending 1 of `MAX_AI_CALLS=4` (`:17`) each time; worst case it also starves the other 18 bare rows (19/27 bare on live).
Why it costs money: repeated AI spend with the result discarded, plus an invisible queue blockage on the exact rows (unbriefed proposals) the owner must clear to reach a decision.
Fix: on brief failure, append a dated `[brief failed]` line to the row notes (newest-kept idiom) and skip rows with ≥2 recent failures for 7 days, and include a `brief_fail:1` bit in the run `error` string so the Research log shows it. Touch `worker/src/index.js`, `worker/src/index.test.js`. Size S. Risk: low — best-effort path, no status moves, no budget change.

**F2 — Every Vet / Kill / Vet-&-starter tap fetches the review queue twice on top of the full list.**
Evidence: `vetOpportunity` ends `await refresh(); await refreshReview();` (`public/app.js:391-392`), and `vetAndLogStarter` (`:429-430`) and `killOpportunity` (`:452-453`) repeat it — but `refresh()` itself already calls `await refreshReview()` (`:1131`). Each `refreshReview` is a full `api("/api/opportunities?unreviewed=1&sort=oldest&limit=200")` (`:224-228`) whose rows are a subset of `state.opportunities` already in memory with identical columns (`brief_first_steps`, `brief_summary` selected unconditionally at `functions/api/[[path]].js:56-65`).
Why it costs money: 3× the list reads per decision tap (full list + review list × 2), each row carrying 4 correlated subqueries — pure D1 rows-read and phone latency on the exact taps that must feel instant to drain 11 unreviewed rows.
Fix: derive the review list client-side from `state.opportunities` (filter `UNREVIEWED` in notes, sort oldest-first — the same predicate and order as the server), drop the second fetch, and keep `GET /api/opportunities?unreviewed=1` for deep links. Touch `public/app.js`, `public/dashboard.test.mjs`. Size S. Risk: low — read-only derivation, server endpoint untouched.

**F3 — The Start-here strip refetches a full detail payload for one line the list already carries.**
Evidence: `renderStartHere` fires `api(`/api/opportunities/${top.id}`)` (`public/app.js:121-129`, cached in `state.topBriefText`) to compute `firstStepsFirstLine(d.briefs[0])` — yet the top pick comes from `state.opportunities`, whose rows already include `brief_first_steps` (selected at `functions/api/[[path]].js:59`), and `reviewDecisionLine` already consumes it directly: `firstStepsFirstLine({ first_steps: o.brief_first_steps })` (`public/app.js:165`).
Why it costs money: an extra API round trip plus 3 D1 queries (opportunity + briefs + experiments at `functions/api/[[path]].js:73-84`) on every top-pick change, for the #1 strip the owner sees first on his phone.
Fix: use `top.brief_first_steps` in `renderStartHere` with the same "No brief yet" fallback the review line uses, and delete the `topBriefText` fetch path. Touch `public/app.js`, `public/dashboard.test.mjs`. Size S. Risk: low — same string, one fewer request.

**F4 — The worker closes every run with two `finish("ok")` writes; the second overwrites the first.**
Evidence: `await finish("ok");` immediately followed by `await finish("ok", (briefMode === "skipped" ? "" : "brief:" + briefMode) + ...)` (`worker/src/index.js:474-475`), where `finish` is a full `UPDATE agent_runs SET finished_at=..., status=?, signals_seen=?, ...` (`:202-208`).
Why it costs money: one wasted D1 write per run (4+ runs/day plus manual ticks) with zero added information — the first write's empty error string is instantly replaced.
Fix: delete the first call and keep the second (disclosing) one; the static guard (`worker/src/index.test.js:70-71`, "finishes after the brief pass") still holds with a single write. Touch `worker/src/index.js`, `worker/src/index.test.js`. Size S. Risk: low — the surviving statement is byte-identical to today's second write.

**F5 — `/api/health` awaits 13 sequential D1 queries plus a self-fetch of `/release.json` on every call.**
Evidence: thirteen `await env.DB.prepare(...).first()/.all()` in sequence (`functions/api/[[path]].js:356-372`: counts for opportunities, unreviewed, bare, experiments-by-status, last-ok, oldest-unreviewed, decisions, weekly revenue, lifetime revenue, lifetime spend, vetted, vetted-without-experiment, 24h noise), then `await fetch(new URL("/release.json", url.origin))` (`:387-390`) — a full subrequest to itself per health hit. The dashboard calls health on every boot and every `refresh()` (`public/app.js:1124`), i.e. after every vet/kill/start/close.
Why it costs money: stacked sequential round trips on the hottest read path; every decision tap waits on 13 serialized queries plus a self-fetch before the board re-renders.
Fix: issue the independent counts through one `env.DB.batch([...])` call (read-only, same rows, one round trip) and serve `rev` without a subrequest (build-time env var or `ASSETS.fetch`); extend the API mock, which currently has no `batch` (search empty in `functions/api/api.test.mjs`). Touch `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Size M. Risk: low-medium — mock must gain `batch`; keep every existing health key for `verify.sh`.

**F6 — Collect ingests up to ~72 signals/run while triage drains 6, with no DELETE anywhere.**
Evidence: caps allow 4 HN × 8 + 3 Reddit × 8 + 2 GitHub × 8 = up to 72 inserts per run (`worker/src/index.js:14-16,25-28,69,93,116,222-227`) against `SELECT * FROM signals WHERE processed = 0 ORDER BY id ASC LIMIT 6` (`:242-244`); a regex search for `DELETE|delete` across `worker/src/index.js` and `functions/api/` returns nothing, so rows accumulate until the 30d sweep noises them unread (`:235-240`). `INSERT OR IGNORE` dedupes repeats, so the true backlog depth is Unmeasured — what would measure it: `SELECT COUNT(*) FROM signals WHERE processed = 0` on live D1.
Why it costs money: fetched, inserted, then swept as noise without ever being triaged — collection work and storage spent on rows nobody reads, while genuinely fresh signals queue behind them oldest-first.
Fix: shrink collection to triage capacity (fewer queries / smaller pages) OR take more per run within the AI budget, and log the unprocessed depth (`SELECT COUNT(*) WHERE processed = 0`) into the run row so the next audit can measure instead of bound. Touch `worker/src/index.js`, `worker/src/index.test.js`. Size M. Risk: low-medium — touches the cron path; keep the 30d sweep and inflow cap intact.

**F7 — `/api/meta` is refetched on every refresh although it is static per deploy.**
Evidence: `state.meta = await api("/api/meta").catch(() => ({}));` inside `refresh()` (`public/app.js:1130`), while the endpoint returns only deploy-static values (`worker_url`, `writes_enabled`, scoring formula at `functions/api/[[path]].js:393-399`).
Why it costs money: one wasted request per refresh on top of F2's duplicates — noise on every phone tap, zero new information until the next deploy.
Fix: fetch `/api/meta` once per boot (guard on a loaded flag) instead of inside `refresh()`. Touch `public/app.js`, `public/dashboard.test.mjs`. Size S. Risk: low.

**F8 — Agent evidence appends bump `updated_at`, so agent activity moves the human `vetted_last_7d` counter.**
Evidence: all three agent appends bump the touch column — exact-URL pre-pass (`worker/src/index.js:263`), slug-collision path (`:351`), supports path (`:360-364`) — while `vetted_last_7d` counts `notes LIKE '%vetted]%' AND updated_at >= ... '-7 days'` (`functions/api/[[path]].js:369-370`), presented as `N vetted this week` (`public/app.js:599-604`). A row vetted a month ago that receives one supporting signal today counts as "vetted this week" with no human involved; secondarily the newest-kept 8000-char window can evict an old `[date vetted]` tag entirely. (Round-3 F6, verified still present.)
Why it costs money: `vetted_last_7d` is half the lane metric ("vetted proposals that become experiments") and today agent traffic moves it in both directions — the header can claim progress nobody made.
Fix: write the rule down (`README.md`: "agent evidence appends never move human counters — no `updated_at` bump, no status move") and drop `updated_at` from the three agent APPEND statements (keep it on human writes and the outcome ledger at `functions/api/[[path]].js:327`); add an API test pinning a vetted row + signal append staying outside `vetted_last_7d`. Touch `worker/src/index.js`, `worker/src/index.test.js`, `functions/api/api.test.mjs`, `README.md`. Size S. Risk: low-medium — SQL in the hot path; keep `sort=updated` behavior covered by existing tests.

## 5. What NOT to change

- The scoring formula and the honest cap: `score = 100 * (value * confidence * fit) / (effort + 1)` (`README.md:56`, `worker/src/lib.js:15-16`) with `UNREVIEWED` rows clamped to ≤6000 (`worker/src/lib.js:29-32`). Cut waste around the math, not the math.
- "The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed)." (`worker/src/index.js:4-5`; also `README.md:72`: "`researching → testing` is a human decision".) F1's skip rule moves no status.
- "No auto-transitions — the human still owns every status move." (`public/app.js:506`; drawer rescore "never auto-applied", `:766-779`.) Start/Win/Lose/Vet/Kill stay human-pressed; F1–F8 press nothing.
- "Killed strategies stay on the board with their post-mortem — that is the point." (`README.md:63-64`.) Never delete killed rows or their notes; F6's collection trim deletes nothing either.
- The experiment closure gate: `won`/`lost` require non-empty `result` + `post_mortem` (`functions/api/[[path]].js:310-314`), `ended_at` stamped (`:315`). Never mark an experiment decided without evidence, never invent a revenue figure.
- Public-read / token-write split with constant-time compare (`functions/api/[[path]].js:24-32`); `ADMIN_TOKEN` rotation stays a human deploy step (`README.md:85-88`). No tokenless writes, no stored bypass.
- Idempotent deploy: schema always, seed only when the table is empty (`deploy/deploy.sh:30-47`). Never reseed over live rows.
- Manual-triage-only + briefs-on-cron: "Manual `Run triage now (briefs on cron)` collects and triages only (`POST /run` 202 carries `briefs_skipped:true`); briefs land on cron ticks" (`README.md:77`; `worker/src/index.js:548`).
- Anything needing a login, credential, payment, or a human decision: Cloudflare deploys, `CLOUDFLARE_API_TOKEN`, pressing Start, sending the spec ads, pricing a pilot, vet/kill calls, closing experiments. This audit changed no code and read no secrets.

## 6. Proposed next tasks (2–4)

Prerequisite (owner action, not code — this is money question 2): press Start on the spec-ad sprint (`planned:2` on live, $0 to start) and count replies on day 7. No task below substitutes for it.

### Task 1: Record brief failures so one poison row stops burning a Llama call per tick

- Owned files: `worker/src/index.js`, `worker/src/index.test.js`.
- Acceptance: (a) a malformed/empty brief appends a dated `[brief failed]` note instead of vanishing; (b) rows with ≥2 recent failures are skipped for 7 days; (c) the run `error` carries a `brief_fail` bit visible in the Research log; (d) no status moves, AI budget still 4, manual skip intact (`briefs_skipped:true`); (e) `npm test` green.

### Task 2: Derive the review list client-side instead of fetching it twice per tap

- Owned files: `public/app.js`, `public/dashboard.test.mjs`.
- Acceptance: (a) Vet / Kill / Vet-&-starter each trigger at most one list fetch; (b) the client-side list matches the server predicate exactly (UNREVIEWED filter, oldest-first); (c) `GET /api/opportunities?unreviewed=1` still works for deep links; (d) review count + oldest-age chip unchanged; (e) `npm test` green.

### Task 3: Start-here strip reads the list excerpt and meta loads once per boot

- Owned files: `public/app.js`, `public/dashboard.test.mjs`.
- Acceptance: (a) no `/api/opportunities/:id` detail fetch for the strip — it renders `brief_first_steps` from its own row with the "No brief yet" fallback; (b) `topBriefText` fetch path deleted; (c) `/api/meta` fetched once per boot, not per refresh; (d) strip still shows Vet/Kill for unreviewed top picks; (e) `npm test` green.

### Task 4: Close each agent run with a single run-finish write

- Owned files: `worker/src/index.js`, `worker/src/index.test.js`.
- Acceptance: (a) exactly one `finish("ok")` call on the success path, carrying the `brief:` mode + `stale:` disclosures; (b) the quiet-tick guard (finish after the brief pass) still green; (c) error path unchanged; (d) `npm test` green.
