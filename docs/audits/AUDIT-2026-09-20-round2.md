# Audit 2026-09-20 round 2 — aimoney (read-only)

Lane metric: experiments reaching a decision (won/lost with post-mortem) per week, and vetted proposals that become experiments. Live values from the repo's own health endpoint today: decisions_last_7d = 0, vetted_last_7d = 0, unreviewed = 11 (oldest 163.6 h ≈ 6.8 d), 19 of 27 opportunities with no brief, experiments { planned: 2, running/won/lost: 0 }, revenue_last_7d = $0.00. The queue grows; nothing closes.

## 1. What this project is and how it runs

1. Purpose: a ranked list of AI-money opportunities with research briefs and experiments, re-optimized as evidence lands; the human tests, kills, and scales.
2. Entry points: dashboard `public/index.html` + `public/app.js`, API `functions/api/[[path]].js`, research worker `worker/src/index.js` + `worker/src/lib.js`, D1 schema `d1/schema.sql` + `d1/seed.sql`.
3. Live surfaces: `https://aimoney.pages.dev` (dashboard), `/api/health` (this lane's metric source), worker `https://aimoney-research.levitinvlad.workers.dev/`; live rev e1c0018 is one deploy behind HEAD 61d3aac (live health lacks `revenue_total`/`spent_total`).
4. Scheduled jobs: worker cron `0 */6 * * *` (`worker/wrangler.toml:8-9`) — collect signals, one Mistral triage call, Llama briefs (1+1 on cron, skipped on manual `POST /run`); stuck-run reaper at 30 min (`worker/src/index.js:185-190`).
5. Deploy: `./deploy/deploy.sh` (D1 schema idempotent + seed-only-if-empty, stamp `public/release.json`, Pages deploy, worker deploy), `./deploy/verify.sh` checks 7 markers + non-empty list + run freshness; Pages also auto-redeploys on push, worker via `.github/workflows/deploy-worker.yml`.

## 2. End-to-end walk-through

Signal → triage → proposal → brief → vet → experiment → close → money:

1. Collect: cron fires `runResearch(env, "cron")` (`worker/src/index.js:181,480-481`); `Promise.allSettled([hnSignals(), redditSignals(), githubSignals()])` (`:216`; sources `:47,71,95`); one batched `INSERT OR IGNORE` (`:221-226`); unprocessed signals older than 30 d swept to noise (`:235-239`).
2. Take: oldest 6 unprocessed signals (`:241-243`); exact-URL matches link as supports before triage, no AI call (`:249-266` via pure `exactUrlTarget`, `:152-162`).
3. Classify: one Mistral NDJSON call over top-60 list + fresh signals (`:276-293`; budget `MAX_AI_CALLS=4`, `:16`); `parseJsonLines` (`worker/src/lib.js:49-64`); strict validation (`worker/src/index.js:297-313`); `new` inserts a `researching` + `UNREVIEWED` row with humility clamp (`:319-320`) and capped score (`:332`); slug collision links as supports (`:343-347`); `supports` appends `[signal date]` evidence newest-kept (`:352-360`); else noise (`:361-363`).
4. Brief: cron only (`briefDeadline`, `:214`; manual `POST /run` always skips, `:536-544`, 202 `briefs_skipped:true`); oldest-unreviewed-first past 48 h (`:372-384`); one Llama call (`:390-402`); empty/malformed JSON skipped silently (`:404-419`); one extra oldest bare row past 48 h (`:425-468`); run closed with a redundant double `finish("ok")` (`:470-471`).
5. Serve: `GET /api/opportunities` with review queue `?unreviewed=1&sort=oldest` (`functions/api/[[path]].js:42-71`, capped `:66`); detail + briefs + experiments (`:73-84`); health counters incl. `decisions_last_7d`/`vetted_last_7d`/`revenue_last_7d` (`:350-386`); `GET /api/meta` (`:388-394`).
6. Decide (all human): boot `refresh()` (`public/app.js:955-974`); review rows carry capital + next action + source + brief summary with inline Vet/Kill (`:186-218`); Vet clears the marker and appends `[date vetted]`, toast offers Log experiment (`:304-322`); Kill takes an inline post-mortem line (`:324-348`); Start-here strip shows Vet/Kill for unreviewed top picks (`:95-130`); drawer + admin zone for rescore/status (`:557-604,629-726`).
7. Experiment: modal log with dollar→cents conversion (`:824-873`, `:861-862`); board one-click Start (`:397-409`, button `:478`) and one-click Lose (`:416-433`, button `:479`); API create (`functions/api/[[path]].js:236-283`) and update (`:285-335`) enforce result + post-mortem on close (`:306-311`), stamp `started_at`/`ended_at` (`:305,:311`), append a `[$X rev / $Y spent]` outcome line to the parent (`:316-324`); drawer suggests a ±1 rescore, never auto-applied (`public/app.js:617-627`); zero-decision weeks get a read-only stale nudge that opens the drawer (`:460-467`).

Where it most often breaks or goes silent: the human handoffs. Vet → log experiment → flip to testing → Start is four separate actions across three screens, so vetted rows stall before becoming experiments (today: 0 conversions). Wins need drawer → Update → 9-field modal while losses close in one click + one line, so the only cheap decision is "lost" — and with 0 running experiments even that path is idle. The worker adds up to 6 proposals per run against a 2-briefs-per-tick capacity with no inflow cap, so each vet decision gets slower (19 of 27 rows bare). Overflow then vanishes silently: the 30 d sweep noises old signals (`worker/src/index.js:235-239`) and malformed brief JSON is skipped without a marker (`:404-419`).

## 3. Health signals measured here

- `npm test` (the repo's suite; `package.json:7`): 166 pass, 0 fail, 60 suites, duration 1350 ms in this sandbox (Windows baseline in `_night/tests-baseline.log`: 166/166, 220 ms). Only warnings are the known typeless-`package.json` reparse notes.
- `python3 -m compileall`: not applicable — the repo contains zero `.py` files; JS equivalent `node --check` exits 0 on `public/app.js`, `worker/src/index.js`, `worker/src/lib.js`. The API router check (`functions/api/[[path]].js`) was denied by the shell-approval adapter; its parse is proven by the green suite, which imports it (`functions/api/api.test.mjs`).
- TODO density: 0 matches for `TODO|FIXME|XXX|HACK|BUG` across `public/ functions/ worker/ scripts/ deploy/ d1/`.
- Dead code (all verified present): `BRIEF_DEADLINE_MS` defined but never referenced (`worker/src/index.js:20` vs live `briefDeadline` at `:214`); unused `scoreOf` import (`:139`, no other use in file); redundant double `await finish("ok")` (`:470-471`); `GITHUB_QUERIES.slice(0, 2)` silently drops the third query (`:115` vs `:27`); `appendKeepNewest` has zero production callers (`worker/src/lib.js:36-39`, tests only); four dead toast gates after modal returns (`public/app.js:307,327,400,419`, self-commented as superseded).
- Duplicated logic: `clamp10` in the API (`functions/api/[[path]].js:12-16`) vs `worker/src/lib.js:4-7` (near-identical, not shared); the Llama brief prompt + insert is copy-pasted for the extra-brief pass (`worker/src/index.js:393-419` vs `:444-465`); money formatters `centsDollars` (`functions/api/[[path]].js:20`) vs `moneyCents` (`public/app.js:51`) are an intentional commented mirror; `UNREVIEWED` appears as SQL literals (`functions/api/[[path]].js:52,352,356`; `worker/src/index.js:373,380,427,432`) while the exported `UNREVIEWED_MARKER` (`worker/src/lib.js:21`) goes unused outside lib; the vetted tag is string-coupled (`[date vetted]` written at `public/app.js:311`, counted via `LIKE '%vetted]%'` at `functions/api/[[path]].js:364-365`).
- Live surfaces: `_night/live/aimoney_pages_dev.html` matches `public/index.html` exactly except line endings (`diff` exit 1, only CRLF differences). Surface rules all pass, so they expose zero findings: `color-scheme: light` (`public/styles.css:4`), no `prefers-color-scheme`/`data-theme`/theme-toggle in CSS/JS/HTML (those strings appear only inside test assertions), `<link rel="icon" href="/favicon.svg">` + `<meta name="theme-color">` (`public/index.html:9-10`), inline brand mark matching the favicon accent and `$` glyph (`public/index.html:16`, `public/favicon.svg:1`, 285 bytes), guard test `public/tab-icon.test.mjs:48-113` (5 tests, green).
- Live health (`_night/live/aimoney_pages_dev_api_health.html`): `{"ok":true,"rev":"e1c0018","db":"up","opportunities":27,"unreviewed":11,"bare_without_brief":19,"experiments_by_status":{"planned":2},"hours_since_last_ok_run":2,"oldest_unreviewed_age_h":163.6,"decisions_last_7d":0,"revenue_last_7d":0,"vetted_last_7d":0,"vetted_no_experiment":0,"noise_24h":0}`. Worker is fresh (2 h); every decision counter is zero; live rev trails HEAD (no `revenue_total`/`spent_total` keys, which the dashboard already tolerates at `public/app.js:443-444`).
- Note on acceptance: `git status --short` already showed every tracked file as modified (CRLF line-ending normalization) before I wrote anything; I created only this file and edited nothing, so those `M` flags predate this audit.

## 4. Ranked findings (max 8)

Impact order for the lane number (decisions/week, vetted→experiment, backlog drained). No surface-rule findings: the served page is light-only with icon, brand mark, and a guard test (see §3).

**F1 — Vet → log → testing → Start is four actions across three screens; nothing converts.**
Evidence: `public/app.js:304-322` (Vet PATCHes notes, toast at `:317` offers Log experiment) → `openExperimentModal` (`:824-873`, 9+ fields) → admin status flip (`:644-657` + save `:661-706`) → `startExperiment` one PATCH (`:397-409`, board button `:478`). Four visits per row, three screens (review list, modal, drawer/board).
Why it costs money: this is the lane funnel and it converts at zero — `vetted_last_7d: 0`, `vetted_no_experiment: 0` only because nothing was vetted at all. Every extra screen between "this looks good" and "test started" is where 11 unreviewed rows go to age (oldest 6.8 d).
Fix: add one "Vet & log starter" action on review rows that PATCHes the vet tag, POSTs a `planned` experiment seeded from the row (name/hypothesis/metric prefilled, human-editable), and flips the row to `testing`, then toasts with a Start shortcut. Compose existing endpoints; no API change. Touch `public/app.js`, `public/dashboard.test.mjs`. Size M. Risk: low — token-gated like Vet, each write is the same call the human makes today.

**F2 — No one-click Win: recording a win is the hardest action on the board.**
Evidence: board cards render Start and Lose only — `public/app.js:478-479` (`data-start-exp`/`data-lose-exp`, no Win path; `loseExperiment` at `:416-433` sends one line as result + post-mortem) — while a win requires drawer → Update (`:587`) → full modal (`:824-873`) satisfying the API gate (`functions/api/[[path]].js:306-311`).
Why it costs money: friction is asymmetric — the only cheap decision is "lost", and with 0 running experiments even that path is idle. `decisions_last_7d: 0` and `revenue_last_7d: $0.00` will not move until closing a win costs the same as closing a loss.
Fix: mirror Lose with a one-click Win on running (and planned) non-orphaned cards: inline $ amount + one line → PATCH `won` with that line as result and post-mortem and the human-entered amount as `revenue_cents` (never invented; clamp like the modal at `:861-862`), `ended_at` stamped by the API. Touch `public/app.js`, `public/dashboard.test.mjs`. Size M. Risk: low-medium — inline money entry must validate exactly like the modal.

**F3 — Closed money has an amount and a date but no source; round-2 task 4 was never built.**
Evidence: `experiments` carries `revenue_cents`/`spent_cents` (`d1/schema.sql:62-63`, `d1/migrate-2026-09-20-experiment-cents.sql:1-6`) and the ledger line renders `($X rev / $Y spent)` (`functions/api/[[path]].js:319-320`), but no `revenue_source` column exists anywhere (the string appears only in `docs/audits/AUDIT-2026-09-20-round2.md:85,132`); the experiment modal has $ inputs and no source input (`public/app.js:843-844`).
Why it costs money: the first real $500 win will render as an un-auditable `$500.00 rev` with no proof of origin — untrusted and unrepeatable. Lens item 4 (amount + date + source) is two-thirds done.
Fix: additive migration `revenue_source TEXT NOT NULL DEFAULT ''` (re-run tolerated by `deploy/deploy.sh:34-38`); API create/update accept ≤120 chars; both ledger appends carry `via {source}`; board and drawer show it; old rows render unchanged. Touch `d1/migrate-2026-09-20-revenue-source.sql`, `functions/api/[[path]].js`, `public/app.js`, `functions/api/api.test.mjs`, `public/dashboard.test.mjs`. Size M. Risk: low — additive, defaults preserve old rows; display only human-entered cents.

**F4 — The worker adds up to 6 proposals per run against 2 briefs per tick; round-3 task 4 was never built.**
Evidence: `MAX_AI_SIGNALS = 6` (`worker/src/index.js:15`), take at `:241-243`, no cap on `new` inserts (no `MAX_NEW`/cap code anywhere); brief capacity is 1 + 1 extra per cron tick (`:385,435`); cron runs 4×/day. Result today: 11 unreviewed, 19 of 27 bare, oldest 163.6 h.
Why it costs money: inflow permanently exceeds evidence capacity, so each vet decision gets slower (no brief → open drawer → chase the external source) and the queue can never drain from the top. The 30 d noise sweep (`:235-239`) then deletes the overflow silently instead of the worker pacing itself.
Fix: cap `new` inserts at 2 per run; overflow `new`-verdict signals stay `processed = 0` for a later tick. Rule in README ("inflow ≤ brief capacity; reversible — unprocessed signals are retaken, never dropped"); worker test pins cap + retake. Touch `worker/src/index.js`, `worker/src/index.test.js`, `README.md`. Size S. Risk: low — no status moves, no AI-budget change, 30 d sweep still bounds the backlog.

**F5 — The stale nudge fires in exactly today's stall state and lands in the slowest path.**
Evidence: when `decisions === 0` the header names the stalest open card (`public/app.js:460-464`) — true right now (`planned: 2`, decisions 0) — but the button calls `openDrawer(...)` (`:464`), where the only action is Update (`:587`) → modal, instead of the one-click Start the board already owns (`:478` → `:397-409`).
Why it costs money: the single nudge designed for this stall adds 3+ taps to the one action that would move `running` off zero. Read-only visibility again, not removed work.
Fix: make the nudge button switch to the Experiments tab and highlight/scroll to the card (or carry its own Start when the card is `planned`); still human-pressed, still no auto-transitions. Touch `public/app.js`, `public/dashboard.test.mjs`. Size S. Risk: low.

**F6 — Kill and Lose still require typing on a phone; 11 rows need killing.**
Evidence: both route through `inlinePostMortem` (`public/app.js:261-299`, `maxlength 200`, empty cancels, row untouched), invoked at `:347` (Kill) and `:432` (Lose). The gate is a non-empty line, so every kill is a typing exercise on glass.
Why it costs money: typing is the per-row bottleneck for draining 11 unreviewed rows from the bottom. Presets keep the gate (a real line is still sent) while turning the common cases into one tap.
Fix: offer 3 one-tap preset reasons beside the input (Kill: duplicate / no buyer / no evidence; Lose: no replies / no conversion / cost > return) plus the existing custom input; a preset submits as the line. API gate untouched. Touch `public/app.js`, `public/dashboard.test.mjs`. Size S. Risk: low — the closure/post-mortem requirement still holds; presets are human-chosen.

**F7 — Add / Log-experiment / Run dead-end on a toast when the token is missing; Vet/Kill/Start/Lose open the modal.**
Evidence: `public/app.js:777` (Add), `:825` (experiment modal), `:896` (Run) do `return toast("Enter the admin token first.")`, while `:305,325,398,417` do `return openAdminModal(...)`; the dashboard suite pins only the modal half (baseline "token modal + inline post-mortem").
Why it costs money: the exact path F1 relies on — Vet toast → "Log experiment" (`:317`) — dies with a toast if the token lapsed, stranding a decided row. Same for the manual research trigger.
Fix: route all three through `openAdminModal` with the same subnote pattern (`:739-755`); extend the dashboard static tests to cover Add/modal/Run. Touch `public/app.js`, `public/dashboard.test.mjs`. Size S. Risk: low — API 401 behavior unchanged.

**F8 — The concrete $0 experiment exists and sits unpressed: the spec-ad sprint.**
Evidence: `d1/seed.sql:67-71` logs `Spec-ad sprint: 10 brands, 10 free ads` as `planned`, budget `$0 + 10 hours`, metric `replies; pilots closed`, target `>=3 replies; >=1 pilot at >=$500`; `public/app.js:395-396` names it the first Start candidate ("a human still presses it"); its parent `ai-ugc-ads-service` is still `researching` (`d1/seed.sql:6`); health shows `planned: 2`, running 0.
Why it costs money: decisions/week cannot move until something runs, and the cheapest possible start — $0, one press — has been idle while the board accumulated visibility. No code is missing for the start itself.
Fix (owner action, proposed concretely): press Start on the spec-ad card this week; send 10 finished spec ads to 10 real DTC supplement brands built from public assets; at day 7 record the reply count, at day 14 record pilots; close won (≥1 $500 pilot, amount + source entered, F2/F3 make this cheap) or lost (reply count as the result line). Files to touch: none — press Start. Size S (one press + 10 h of sending). Risk: 10 hours, $0 spend; never mark it decided without the reply/pilot counts.

## 5. What NOT to change

- The scoring formula and the honest cap: `score = 100 * (value * confidence * fit) / (effort + 1)` (`README.md:56`, `worker/src/lib.js:15-16`) with `UNREVIEWED` rows clamped to ≤6000 (`worker/src/lib.js:29-32`). Fix ceilings and friction, not the math.
- "The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed)." (`worker/src/index.js:4-5`; also `README.md:72`: "`researching → testing` is a human decision".) F4's inflow cap deliberately moves no status.
- "No auto-transitions — the human still owns every status move." (`public/app.js:459`; drawer rescore "never auto-applied", `:614-617`.) Start/Win/Lose/Vet/Kill stay human-pressed.
- "Killed strategies stay on the board with their post-mortem — that is the point." (`README.md:63-64`.) Never delete killed rows or their notes.
- The experiment closure gate: `won`/`lost` require non-empty `result` + `post_mortem` (`functions/api/[[path]].js:306-311`), `ended_at` stamped (`:311`). F2/F6 send real lines through it; they do not weaken it. Never mark an experiment decided without evidence, never invent a revenue figure.
- Public-read / token-write split with constant-time compare (`functions/api/[[path]].js:24-32`); `ADMIN_TOKEN` rotation stays a human deploy step (`README.md:85-88`: set Pages env + worker secret, redeploy both, re-enter in dashboard). No tokenless writes, no stored bypass.
- Idempotent deploy: schema always, seed only when the table is empty (`deploy/deploy.sh:30-47`). Never reseed over live rows.
- Anything needing a login, credential, payment, or a human decision: Cloudflare deploys, `CLOUDFLARE_API_TOKEN`, sending the spec ads, pricing a pilot, vet/kill calls, closing experiments. This audit changed no code and read no secrets.

## 6. Proposed next tasks (2–4)

### Task 1: One-click Win on running cards: inline $ + one line closes won with real money

- Owned files: `public/app.js`, `public/dashboard.test.mjs`.
- Acceptance: (a) running (and planned) non-orphaned cards show Win beside Lose; (b) one click + $ amount + one line PATCHes `won` with the line as `result` and `post_mortem`, the human-entered amount as `revenue_cents`, `ended_at` stamped; (c) empty line cancels, row untouched; bad/negative amounts clamp to 0 exactly like the modal; (d) API closure gate unchanged; (e) dashboard tests cover Win happy-path, cancel, clamp, 401-without-token, orphan exclusion; (f) `npm test` green.

### Task 2: Cap worker to 2 new proposals per run; overflow signals retake later

- Owned files: `worker/src/index.js`, `worker/src/index.test.js`, `README.md`.
- Acceptance: (a) at most 2 `new` inserts per run; overflow `new`-verdict signals stay `processed = 0` for a later tick; (b) noise/`supports` paths and verdict validation untouched; (c) manual `POST /run` still 202s with `briefs_skipped:true`; (d) 30 d sweep still bounds the backlog; (e) `README.md` states the rule (reversible, no status moves); worker test pins cap + retake; (f) `npm test` green.

### Task 3: Add revenue_source: migration, API, ledger via-line, board display

- Owned files: `d1/migrate-2026-09-20-revenue-source.sql`, `functions/api/[[path]].js`, `public/app.js`, `functions/api/api.test.mjs`, `public/dashboard.test.mjs`.
- Acceptance: (a) additive migration adds `revenue_source` default `''`, re-run tolerated by `deploy/deploy.sh:34-38`; (b) create/update accept ≤120 chars; (c) both ledger appends carry `via {source}`; (d) board and drawer cards show amount with source; (e) old rows (empty source, zero cents) render unchanged; (f) API + dashboard tests pin all of it; (g) no invented figures — only human-entered cents displayed; (h) `npm test` green.

### Task 4: Route Add/Log-experiment/Run token gates to the admin modal

- Owned files: `public/app.js`, `public/dashboard.test.mjs`.
- Acceptance: (a) Add opportunity, Log/Update experiment, and Run triage open the admin modal with a subnote instead of a dead-end toast when the token is missing; (b) API still 401s without the token; (c) dashboard static tests cover all three gates; (d) `npm test` green; (e) no API change.
