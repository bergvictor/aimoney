# AUDIT 2026-09-20 — aimoney (round 2, bottleneck lane)

Clone HEAD: `7d3be4a` ("Night round 1: agent estimates, review line, one-click Start"). Live rev (`_night/live/aimoney_pages_dev_api_health.html`): `859295c` — live is ONE deploy behind HEAD, so tonight's round-1 tasks are shipped in the clone but not yet live.
Lane metric right now (live payload, 2026-09-20T18:02Z): **0 decisions/week, 0 vetted/week, 11 unreviewed (oldest 161.7h ≈ 6.7d), 19/27 rows without a brief, 2 planned / 0 running experiments, `revenue_last_7d: 0` measured-zero** (key present, value 0 — not unmeasured). Fifth straight snapshot with decisions and vetted both at zero.
No repo-local `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING.md` exists; governed by `README.md` plus the standing rules.
Surfaces judgment: saved live copy is content-identical to repo `public/index.html`; compliant — light palette only (`public/styles.css:4` `color-scheme: light`, no dark branch by search), favicon + `theme-color` (`public/index.html:9-10`, `public/favicon.svg` 1 line, ~300 bytes), inline brand mark (`public/index.html:16`), guard test green (`public/tab-icon.test.mjs`, 5/5 in suite). **Zero surface-rule findings this round.**
Note: round-1 audit tasks 1–3 are DONE at HEAD (verified: `agentMoneyEstimates` in `worker/src/index.js:146-157`, `reviewDecisionLine` in `public/app.js:155-164`, `startExperiment` in `public/app.js:325-335`). This round audits what still blocks the metric after them.

## 1. What this project is and how it runs

- Purpose: AIMoney Lab — a ranked board of AI-money opportunities with evidence briefs and experiments (`README.md:1-15`).
- Entry points: dashboard `public/app.js` + `public/index.html`; API `functions/api/[[path]].js`; agent `worker/src/index.js`.
- Live surfaces: `https://aimoney.pages.dev`, `/api/health`, research worker (`README.md:27-31`, `deploy/public-surfaces.json:31-44`).
- Scheduled jobs: worker cron every 6h (`worker/wrangler.toml:8-9`); manual triage-only `POST /run` (`worker/src/index.js:481-490`).
- Deploys: `./deploy/deploy.sh` (D1 schema + `migrate-*.sql` + seed-if-empty, stamp `release.json`, Pages, worker), `./deploy/verify.sh` gates rollout.

## 2. End-to-end walk-through

1. Collect: cron tick → `runResearch(env,"cron")` (`worker/src/index.js:159`) fans out HN/Reddit/GitHub (`:194`), batch-inserts signals (`:200-204`).
2. Sweep + take: 30d-stale signals → noise (`:212-217`); oldest 6 unprocessed taken (`:219-221`); empty take skips only the classify call (`:222-225`), brief pass still runs.
3. Triage: one Mistral NDJSON pass over top-60 list + fresh signals (`:228-248`); `new` inserts capped `UNREVIEWED` rows with money estimates (`:269-296`), `supports` appends evidence (`:297-305`), else noise (`:306-308`).
4. Brief: one bare row (top-scored, or oldest-unreviewed past 48h, `:311-329`) + one extra oldest bare row past 48h on cron (`:370-414`); empty/malformed brief JSON is skipped silently (`:353`, `:400`).
5. Serve: `GET /api/opportunities` returns `effectiveScore`-capped rows (`functions/api/[[path]].js:62-66`) with brief excerpt (`:56`); health carries queue + money counters (`:344-378`).
6. Vet: human Vet/Kill in review list (`public/app.js:240-276`, decision line at `:155-164`, no drawer needed now) or drawer (`:494-497`); vet appends `[date vetted]`, lifts the 6000 cap; kill requires a post-mortem prompt.
7. Test: `researching → testing` by hand; experiment `planned → running` is now one click (`public/app.js:378`, `:753-758`); close to `won/lost` still needs card → drawer → Update → modal → save (`:699-748`) with result + post-mortem gated by the API (`functions/api/[[path]].js:301-306`); drawer suggests a ±1 rescore, never auto-applied (`public/app.js:515-525`).
8. Where it breaks/goes silent, in order: **(a)** the vet queue never drains — 11 unreviewed, oldest 6.7d, `vetted_last_7d: 0`, and the fastest surface (the strip) still can't decide (`public/app.js:109` renders only `Open in drawer`); **(b)** closing an experiment costs a full modal round-trip, so decisions/week sits at 0 with no one-click close anywhere on the board (`public/app.js:368-380` has Start but no Lose); **(c)** brief coverage is 8/27 and the worker writes at most 2 briefs per 6h tick, so 19 rows decide on estimates alone; **(d)** orphaned experiment cards dead-end in a toast and can never reach a decision (`public/app.js:384`).

## 3. Health signals measured here

- `npm test` (this Linux checkout, exit 0): **121 pass / 0 fail, 45 suites, duration_ms 898.81701** — matches the committed baseline (`_night/tests-baseline.log`: 121/45, Windows `duration_ms 280.1085`); only warnings are the known `MODULE_TYPELESS_PACKAGE_JSON` reparsing notes and sandbox proxy notes.
- `node --check public/app.js`: exit 0 (parse-clean; only a sandbox proxy warning). All other JS modules are import-parsed by the suite itself.
- `python3 -m compileall`: N/A — repo contains zero `*.py` files (glob search for `**/*.py` returns nothing; JS-only: Pages + Functions + Worker, `node --test` suites).
- Dead code (all still present, carried as polish): `BRIEF_DEADLINE_MS` defined but never referenced (`worker/src/index.js:20` vs the trigger-based `briefDeadline` at `:192`); unused `scoreOf` import (`worker/src/index.js:139`, no other use in file); redundant double `await finish("ok")` (`worker/src/index.js:415-416`); `GITHUB_QUERIES.slice(0,2)` silently drops `ai-side-project` (`:115` vs `:27`); `appendKeepNewest` has zero production callers (`worker/src/lib.js:36-39`, tests only).
- Duplicated logic: classify prompt text duplicated between the pass (`worker/src/index.js:231-241`) and `/debug-classify` (`:460-469`); brief-insert block duplicated for main (`:353-363`) and extra (`:400-410`) briefs; create-vs-update string bounds differ (`createOpportunity` slices, `functions/api/[[path]].js:87-102`, vs `updateOpportunity` raw `String(b[f])`, `:126-129`; same split on experiments create `:257-268` vs update `:287-290`); worker token checks use `!==` in three places (`worker/src/index.js:438,453,484`) vs the API constant-time compare (`functions/api/[[path]].js:21-29`).
- TODO density: **0** — search for `TODO|FIXME|HACK|XXX` across `public/`, `functions/`, `worker/`, `d1/`, `scripts/`, `deploy/` returns nothing.

## 4. Ranked findings (max 8)

### F1 — The Start-here strip names the pick but can't decide it: no Vet/Kill on the strip

- Evidence: `renderStartHere` (`public/app.js:93-121`) renders money, capital, next action, then a single `<button id="start-here-open" class="btn small" type="button">Open in drawer</button>` (`:109`). The `vetOpportunity`/`killOpportunity` handlers it could reuse already exist (`:240-276`) and are already reused by the drawer (`:494-497`). The ledger it otherwise forces open is a 10-column table (`public/index.html:59-70`) that horizontal-scrolls on a phone.
- Why it costs money: the strip is the only surface shaped like a sub-minute phone decision, but the fastest path still costs a drawer round-trip (fetch, scroll, find Vet) for exactly the row ranked most worthy of attention. The 11-deep, 6.7d-old queue never drains at one drawer-trip per row.
- Fix: show Vet/Kill buttons on the strip when the top pick carries `UNREVIEWED`, reusing the review handlers plus the existing refresh; vetted picks keep the strip as-is. Static tests for shown/hidden + handler reuse. Touch `public/app.js`, `public/dashboard.test.mjs`.
- Size S. Risk: low (reuses proven handlers; no new API shape).

### F2 — Closing an experiment costs a modal round-trip; there is no one-click Lose, so decisions/week is 0

- Evidence: board cards carry exactly one action — Start on `planned` (`public/app.js:378`); every other move needs card → drawer → Update → modal → save (`:699-748`). The API closure gate itself is fine (`functions/api/[[path]].js:301-306`: `result` + `post_mortem` required, `ended_at` auto-stamps), but nothing on the board feeds it in one tap. Live: `planned:2/running:0`, `decisions_last_7d:0` across five snapshots.
- Why it costs money: closing is the lane metric (decisions/week) and it takes 5+ clicks across three surfaces on a phone; the queue of open experiments can only grow. The kill flow already proved the cheap pattern: `prompt("One-line post-mortem (required to kill):")` (`public/app.js:260`).
- Fix: one-click Lose on `planned`/`running` cards (token-gated, orphaned cards excluded): one `prompt()` for the post-mortem line, then a single PATCH to `lost` sending that line as both `result` and `post_mortem` so the API gate holds unchanged. Mirror the Start delegation (`:753-758`). API + static tests pin the gate and the orphan exclusion. Touch `public/app.js`, `public/dashboard.test.mjs`, `functions/api/api.test.mjs`.
- Size S. Risk: low-medium (second one-click status write from the board; narrow to open → `lost` only, human-pressed).

### F3 — The Zero-spend filter misses anything the model doesn't spell "$0": free-text in, prefix-match out

- Evidence: the chip matches `String((o && o.capital_needed) || "").trim().startsWith("$0")` (`public/app.js:80-81`), but the worker stores whatever the model wrote verbatim: `capital_needed: String(o.capital_needed || "").slice(0, 120)` (`worker/src/index.js:154`). The prompt only suggests `"$0" style` (`:239`). A model writing `None`, `Free`, `0`, or `unknown` silently drops the row from the filter; seeds show the phrasing spread (`$0-200/mo tools`, `$0`, `$100-400/mo telco+AI`, `d1/seed.sql:6-13`).
- Why it costs money: Zero-spend is the discovery path for the owner's $0-experiment directive; every agent row it misses is a startable experiment the owner never sees. The filter, not the data, is the bottleneck.
- Fix: make `isZeroSpend` match case-insensitively against `^\s*(\$0|0(\b|\s)|free|none)\b` so existing rows fix themselves read-only, and normalize the same spellings to `"$0 …"`-form inside `agentMoneyEstimates` for new rows (reversible: raw phrasing preserved after the prefix). Tests for both halves. Touch `public/app.js`, `worker/src/index.js`, `public/dashboard.test.mjs`, `worker/src/index.test.js`.
- Size S. Risk: low (read path is display-only; write path keeps the stored string human-editable).

### F4 — The queue has no top-drain: the worker adds rows but can never retire its own stale proposals

- Evidence: `new` inserts are unconditional (`worker/src/index.js:269-296`) — no queue-depth check; "The agent never moves status." (`README.md:72`; `worker/src/index.js:4-5`). The 30d signal sweep (`:212-217`) bounds signal backlog, but nothing equivalent exists for agent proposals: inflow without outflow, oldest now 6.7d with 11 waiting.
- Why it costs money: every proposal the owner will never review still costs triage attention implicitly (queue length, oldest-age pressure) and dilutes the review chip's signal. A bounded, self-draining top is what lets the queue shrink without him.
- Fix: narrow, written-down rule (README + code comment): on cron ticks, rows that are `source='agent'` AND still `UNREVIEWED` AND `created_at` older than 30d flip to `killed` with a notes line `[date auto-retire] rule: unreviewed agent proposal older than 30d; reopen by flipping status back`. Reversible (status flip + reason preserved; killed rows stay listed per `README.md:64`); counted in the run log; worker test pins the three-conjunct predicate. Honest scope note: fires on nothing today (oldest 6.7d) — it prevents the next wedge, it doesn't clear this one. Touch `worker/src/index.js`, `worker/src/index.test.js`, `README.md`.
- Size M. Risk: medium (first worker status move ever; keep the predicate to the three conjuncts and never touch human rows).

### F5 — Concrete $0 7-day experiment, proposed: run the spec-ad sprint this week and let the reply count decide it

- Evidence: the starter already exists in-repo and is still `planned`: 'Spec-ad sprint: 10 brands, 10 free ads' (`d1/seed.sql:66-71`) — cost `$0 + 10 hours`, metric `replies; pilots closed`, target `>=3 replies; >=1 pilot at >=$500`, hypothesis "at least 1 replies and 1 converts to a paid pilot within 14 days". Its first step is written (`d1/seed.sql:29`: "Pick 1 niche (supplements). Generate 10 spec ads…"). Live: `planned:2/running:0` — it has never started. One-click Start now exists (`public/app.js:378`).
- Why it costs money: this is the only artifact in the repo that can move decisions/week from 0 to 1 with zero spend, and it has sat `planned` through every snapshot. No code change produces a number; pressing Start does.
- Fix (human action, no code): Monday — press Start on the spec-ad sprint card; Tuesday–Wednesday — generate and send 10 spec ads to 10 supplement brands from public assets; Friday day 7 — count replies and close the card `won` (≥1 pilot at ≥$500, log `revenue_cents` + payer) or `lost` (log the reply count as `result`, e.g. "2/10 replies, 0 pilots"). Either close is a decision with evidence. Nothing to touch; the number lands in `/api/health` (`decisions_last_7d`, `revenue_last_7d`) on close.
- Size S (one week of wall-clock, ~10 hours of work). Risk: low (zero spend; worst case is a `lost` with a real reply-rate number).

### F6 — The outcome ledger records the verdict but omits the money

- Evidence: the create-path ledger line is `"…" + status + ": " + oneLine` (`functions/api/[[path]].js:269-276`) and the update-path line is `` `[${day} outcome] Experiment "…" ${status}: ${oneLine}` `` (`:311-317`) — neither includes `revenue_cents`/`spent_cents`, though both are in scope at each site (`:254-256`, `:295-298`). The permanent notes record of a `won` experiment never states what it made or spent.
- Why it costs money: the ledger is the durable money record (health windows expire after 7d); without amounts it degrades to another status line, and the "closed experiment's money is real" bar fails exactly where it should hold.
- Fix: append `+$X revenue / -$Y spent` (fixed-2dp, same idiom as `moneyCents`, `public/app.js:51`) to both ledger lines, omitting zero legs; API tests pin the format on create-close and PATCH-close. Touch `functions/api/[[path]].js`, `functions/api/api.test.mjs`.
- Size S. Risk: low (append-only string change; scores and closure rules untouched).

### F7 — Revenue has an amount and a date but no source, so it stays unverifiable

- Evidence: the `experiments` table has no revenue-source column (`d1/schema.sql:48-68`); board cards show a bare `$X rev` (`public/app.js:375`); health sums cents only (`functions/api/[[path]].js:355`); `ended_at` supplies the date (`:306`) but nothing names the payer or channel.
- Why it costs money: "$500 revenue" with no source is a claim, not a fact — the owner's bar is amount + date + source, and the third leg is missing everywhere it would be recorded or displayed.
- Fix: additive migration `d1/migrate-2026-09-20-revenue-source.sql` (`revenue_source TEXT NOT NULL DEFAULT ''`, following the cents-migration pattern deploy tolerates on re-run, `deploy/deploy.sh:34-38` + `d1/migrate-2026-09-20-experiment-cents.sql:1-6`); API create/update accept ≤120 chars; board card shows `via {source}`; F6's ledger line includes it. Tests for migration-shape, API round-trip, and old-row (empty source) display. Touch `d1/migrate-2026-09-20-revenue-source.sql`, `functions/api/[[path]].js`, `public/app.js`, both test files.
- Size M. Risk: low-medium (additive migration defaults empty; old rows and reads unaffected).

### F8 — Orphaned experiments can never reach a decision from the UI

- Evidence: `LEFT JOIN` keeps dangling rows with `orphaned:true` (`functions/api/[[path]].js:217-228`); the board renders an `orphaned` pill but the click dead-ends in `toast("Orphaned experiment — its opportunity was deleted.")` (`public/app.js:384`); the router has no DELETE (`:338-404`, GET/POST/PATCH/PUT only) and schema FKs are advisory without `PRAGMA foreign_keys` (`d1/schema.sql:50`).
- Why it costs money: orphans can never become won/lost from any UI path, so they pollute experiment counts and leak the lane metric (decisions/week) with rows no human action can close.
- Fix: admin-only `DELETE /api/experiments/:id` (same `authed` + 404 shape as update) with a `Delete` button on orphaned cards only, behind the token check with a confirm; keep the toast for non-admins. API tests for 401/404/happy-path. Touch `functions/api/[[path]].js`, `public/app.js`, `functions/api/api.test.mjs`.
- Size M. Risk: medium (first DELETE endpoint; restrict to experiments, never cascade to opportunities).

## 5. What NOT to change

- Scoring formula: `score = 100 * (value * confidence * fit) / (effort + 1)`, inputs 1–10 (`README.md:56`; `worker/src/lib.js:15-16`). No finding changes the math.
- Human-owns-status, except the one written F4 rule: "The agent never moves status." (`README.md:72`); "The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed)." (`worker/src/index.js:4-5`). F4's auto-retire is the single exception, and only because the rule is written down and the move is reversible.
- Manual-triage-only + briefs-on-cron: "Manual `Run triage now (briefs on cron)` collects and triages only (`POST /run` 202 carries `briefs_skipped:true`); briefs land on cron ticks" (`README.md:77`; `worker/src/index.js:192`). F3/F4 must preserve the manual skip.
- Killed-with-learning: "Killed strategies stay on the board with their post-mortem — that is the point." (`README.md:64`); "Closing an experiment as `won`/`lost` requires `result` + `post_mortem`" (`README.md:74`). F2 keeps the closure gate (same line sent as both fields); F8 deletes orphaned *experiments*, never killed opportunities.
- Capped humility + honest display: proposals "enter as `researching` with an `UNREVIEWED` marker in notes and an effective score capped to ≤6000 until a human vets them" (`README.md:65`); "rows without a brief carry a 'no brief' pill" (`README.md:78`). Vet/kill stay human (F1 only moves the buttons).
- Never-auto-applied rescore: "offers a suggested ±1 value/confidence rescore the human applies with one click — never auto-applied" (`README.md:74`; `public/app.js:515-525`).
- Read-only warnings: badges "flag status mismatches read-only — the human still owns every status move" (`README.md:79`).
- Seed-vs-live accounting: "Seed runs once on an empty table; live count = 12 seeds + agent proposals + manual adds." (`README.md:83`); deploy's seed-if-empty stays (`deploy/deploy.sh:39-47`). F5 starts the seeded sprint; it does not re-seed.
- Auth split and secrets: "Reads are public. Writes require `Authorization: Bearer <ADMIN_TOKEN>`." (`functions/api/[[path]].js:1-2`); "No expiry; rotate manually when shared or leaked." (`README.md:88`).
- Never invent a revenue figure and never mark an experiment decided without evidence: no finding fabricates amounts (F6/F7 only record human-entered cents) and none auto-closes experiments; F5's close carries the counted replies.
- Anything needing a login, payment, or human judgment: vetting the 11 `UNREVIEWED` rows, `researching → testing → scaling` moves, pressing Start/Lose, post-mortems, niches/pricing/outreach, token rotation. The most valuable move on the lane metric remains non-code: a human vetting the 11 oldest-first and starting one `planned` experiment.
- Live is one deploy behind HEAD (`859295c` live vs `7d3be4a` clone): deploying is the orchestrator's call, not an audit edit — this report makes no git writes.
- Live surfaces already compliant (light palette, favicon + theme-color, brand mark, guard test green) — do not restyle, re-palette, or re-icon. No new visibility nudges per the stop-adding-visibility directive.
- Carried polish, intentionally not findings: update-path string bounds, worker `!==` token compare, and the §3 dead-code/duplication list move no lane number; fix opportunistically, never as the headline.

## 6. Proposed next tasks (2–4)

### Task 1: Vet/Kill on the Start-here strip for unreviewed top picks

- Owned files: `public/app.js`, `public/dashboard.test.mjs`.
- Acceptance: (a) strip shows Vet/Kill when the top pick carries `UNREVIEWED`, reusing the review handlers; (b) vetted top picks render the strip unchanged; (c) vet still toasts the Log-experiment handoff and refreshes; (d) static tests lock shown/hidden + reuse; (e) `npm test` green.

### Task 2: One-click Lose on open experiment cards with prompt post-mortem

- Owned files: `public/app.js`, `public/dashboard.test.mjs`, `functions/api/api.test.mjs`.
- Acceptance: (a) `planned`/`running` cards show Lose (token-gated; orphaned cards excluded); (b) one click + one prompt line PATCHes `lost` with that line as `result` and `post_mortem`, `ended_at` stamped; (c) API gate unchanged (empty line cancels, row untouched); (d) tests cover Lose happy-path, 401 without token, orphan exclusion; (e) `npm test` green.

### Task 3: Zero-spend matching tolerates model phrasings, new rows normalized

- Owned files: `public/app.js`, `worker/src/index.js`, `public/dashboard.test.mjs`, `worker/src/index.test.js`.
- Acceptance: (a) `isZeroSpend` matches `$0`, bare `0`, `free`, `none` case-insensitively; (b) `agentMoneyEstimates` normalizes those spellings to a `"$0 …"`-form prefix, raw phrasing preserved; (c) seeds and existing rows render unchanged except newly-matched ones; (d) dashboard + worker tests pin both halves; (e) `npm test` green; (f) no extra AI calls, no status moves, manual `briefs_skipped:true` intact.

### Task 4: Outcome ledger and board state revenue amount with its source

- Owned files: `d1/migrate-2026-09-20-revenue-source.sql`, `functions/api/[[path]].js`, `public/app.js`, `functions/api/api.test.mjs`, `public/dashboard.test.mjs`.
- Acceptance: (a) additive migration adds `revenue_source` (default `''`; re-run tolerated by `deploy/deploy.sh:34-38`); (b) both ledger lines (create-close, PATCH-close) carry `+$X revenue / -$Y spent` and `via {source}`; (c) board cards show the amount with source; (d) old rows (empty source, zero cents) render unchanged; (e) API + dashboard tests pin all of it; (f) `npm test` green; (g) no invented figures — only human-entered cents are ever displayed.
