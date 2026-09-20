# AUDIT 2026-09-20 — aimoney (round 1, bottleneck lane)

Clone HEAD: `859295c` ("Night round 3"). Live rev (`_night/live/aimoney_pages_dev_api_health.html`): `859295c` — live is current this round.
Lane metric right now (live payload, 2026-09-20T17:46Z): **0 decisions/week, 0 vetted/week, 11 unreviewed (oldest 161.4h ≈ 6.7d), 19/27 rows without a brief, 2 planned / 0 running experiments, `revenue_last_7d: 0` measured-zero** (key present, value 0 — not unmeasured). Fourth straight snapshot with decisions and vetted both at zero.
No repo-local `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING.md` exists; governed by `README.md` plus the standing rules.
Surfaces judgment: repo `public/index.html` is line-identical to the saved live copy; compliant — light palette only (`public/styles.css:4` `color-scheme: light`, no dark branch by search), favicon + `theme-color` (`public/index.html:9-10`, `public/favicon.svg`), inline brand mark (`public/index.html:16`), guard test green (`public/tab-icon.test.mjs`). **Zero surface-rule findings this round.**
Note: round-3's proposed Task 4 (a Priority-side stall nudge) was deliberately NOT carried — the owner directive for this lane is "stop adding visibility and start removing the work", and a nudge is visibility.

## 1. What this project is and how it runs

- Purpose: AIMoney Lab — a ranked board of AI-money opportunities with evidence briefs and experiments (`README.md:1-15`).
- Entry points: dashboard `public/app.js` + `public/index.html`; API `functions/api/[[path]].js`; agent `worker/src/index.js`.
- Live surfaces: `https://aimoney.pages.dev`, `/api/health`, research worker (`README.md:27-31`, `deploy/public-surfaces.json:31-44`).
- Scheduled jobs: worker cron every 6h (`worker/wrangler.toml:8-9`); manual triage-only `POST /run` (`worker/src/index.js:460-469`).
- Deploys: `./deploy/deploy.sh` (D1 schema + `migrate-*.sql` + seed-if-empty, stamp `release.json`, Pages, worker), `./deploy/verify.sh` gates rollout.

## 2. End-to-end walk-through

1. Collect: cron tick → `runResearch(env,"cron")` (`worker/src/index.js:141`) fans out HN/Reddit/GitHub (`:176`), batch-inserts signals (`:182-186`).
2. Sweep + take: 30d-stale signals → noise (`:195-199`); oldest 6 unprocessed taken (`:201-203`); empty take skips only the classify call (`:204-207`), brief pass still runs.
3. Triage: one Mistral NDJSON pass over top-60 list + fresh signals (`:209-230`); `new` inserts capped `UNREVIEWED` rows (`:251-275`), `supports` appends evidence (`:276-284`), else noise (`:285-287`).
4. Brief: one bare row (top-scored, or oldest-unreviewed past 48h, `:290-308`) + one extra oldest bare row past 48h on cron (`:349-393`); empty/malformed brief JSON is skipped silently (`:343`, `:390`).
5. Serve: `GET /api/opportunities` returns `effectiveScore`-capped rows (`functions/api/[[path]].js:61-64`); health carries queue + money counters (`:343-377`).
6. Vet: human Vet/Kill in review list (`public/app.js:224-260`) or drawer (`:460-462`); vet appends `[date vetted]`, lifts the 6000 cap; kill requires a post-mortem prompt.
7. Test: `researching → testing` by hand; experiment `planned → running → won/lost` with closure rules + cents + outcome ledger (`functions/api/[[path]].js:231-328`); drawer suggests a ±1 rescore, never auto-applied (`public/app.js:480-490`).
8. Where it breaks/goes silent, in order: **(a)** agent rows arrive with zero money fields, so every vet decision needs from-scratch research (`worker/src/index.js:261-269` omits the columns) — the 11 unreviewed sit 6.7d; **(b)** review rows hide capital/next-action/source, forcing a drawer round-trip per row on a 10-column phone table (`public/app.js:154-170`); **(c)** starting an experiment costs card → drawer → Update → modal → save, so `planned:2/running:0` never moves (`public/app.js:339-345` cards have no actions); **(d)** orphaned experiment cards dead-end in a toast and can never be decided from the UI (`public/app.js:348-349`).

## 3. Health signals measured here

- `npm test` (this Linux checkout, exit 0): **100 pass / 0 fail, 39 suites, duration_ms 689.39** — up from round 3's 94/36; only warnings are the known `MODULE_TYPELESS_PACKAGE_JSON` reparsing notes and sandbox proxy notes.
- `node --check public/app.js`: exit 0 (parse-clean; only a sandbox proxy warning). All other JS modules are import-parsed by the suite itself.
- `python3 -m compileall`: N/A — repo contains zero `*.py` files (JS-only: Pages + Functions + Worker, `node --test` suites).
- Dead code (all still present, carried as polish): `BRIEF_DEADLINE_MS` defined but never referenced (`worker/src/index.js:20` vs live `:174`); unused `scoreOf` import (`worker/src/index.js:139`, no other use in file); redundant double `await finish("ok")` (`worker/src/index.js:394-395`); `GITHUB_QUERIES.slice(0,2)` silently drops `ai-side-project` (`:115` vs `:27`); `appendKeepNewest` has zero production callers (`worker/src/lib.js:36-39`, SQL does the truncation inline).
- Duplicated logic: classify prompt text duplicated between the pass (`worker/src/index.js:213-223`) and `/debug-classify` (`:439-448`); brief-insert block duplicated for main (`:333-341`) and extra (`:380-387`) briefs; create-vs-update string bounds differ (`createOpportunity` slices, `functions/api/[[path]].js:87-101`, vs `updateOpportunity` raw `String(b[f])`, `:124-128`; same split on experiments create `:258-267` vs update `:286-289`); worker token checks use `!==` in three places (`worker/src/index.js:417,432,463`) vs the API constant-time compare (`functions/api/[[path]].js:21-29`).
- TODO density: **0** — search for `TODO|FIXME|HACK|XXX` across `public/`, `functions/`, `worker/src/`, `d1/`, `scripts/`, `deploy/` returns nothing.

## 4. Ranked findings (max 8)

### F1 — Agent proposals arrive with zero money fields, so every new row is undecidable at a glance

- Evidence: the triage verdict schema asks only for `n,action,opportunity_id,title,one_liner,category,value,effort,confidence,fit` (`worker/src/index.js:220-222`); the `new`-row INSERT binds no money columns (`:261-269`), leaving `est_monthly_low/high` at 0 and `capital_needed`/`time_to_first_dollar` empty. The drawer then renders `—` for all three (`public/app.js:433-435`) plus "No brief yet" (`:405`), and the Zero-spend filter (`:80-81`, `startsWith("$0")`) can never match an agent row.
- Why it costs money: the 11 unreviewed rows — the whole vet queue — carry literally no decision inputs. Seeds prove the alternative (`d1/seed.sql:6` has `$0-200/mo tools`, `2-4 weeks`, `2000,8000`). The owner must research each row from scratch or skip it; he skips (oldest 6.7d, `vetted_last_7d: 0` across four snapshots).
- Fix: extend the verdict schema with `est_monthly_low, est_monthly_high, capital_needed, time_to_first_dollar`, clamp with the existing `clamp10`/range-guard shape (missing keys default safely), insert them, and tag notes "agent estimates — correct on vet". Same AI call, zero extra budget; every field stays human-editable in the drawer, so the decision is reversible; write the rule in `README.md`. Touch `worker/src/index.js`, `worker/src/index.test.js`, `README.md`.
- Size M. Risk: low-medium (touches the cron path; keep the AI budget and manual `briefs_skipped:true` contract intact).

### F2 — Review rows hide the decision: no capital, no next action, no source link

- Evidence: `renderReview` (`public/app.js:154-170`) renders title, one-liner, Vet/Kill, status, score, four meters, `$/mo`, First $ — but not `capital_needed` (the zero-spend signal), not the brief's first action, not the `source_url`. `capital_needed` and `source_url` are already in the list payload (`SELECT o.*`, `functions/api/[[path]].js:53-60`) and merely unrendered; only the brief excerpt needs API work.
- Why it costs money: the vet-vs-kill call needs capital-to-start + first action + source in front of the decider; today each row costs a drawer round-trip on a 10-column table (`public/index.html:59-70`) that horizontal-scrolls on a phone. Minutes per decision × 11 rows = a queue that never drains.
- Fix: render a compact decision line under each review row — `Capital: … · Next: … · source` — from existing fields plus a first-`first_steps`-line excerpt added to the list API via one scalar subquery (null-safe, hidden when absent). Static tests lock the line and the null case. Touch `public/app.js`, `functions/api/[[path]].js`, `public/dashboard.test.mjs`, `functions/api/api.test.mjs`.
- Size M. Risk: low (read-only render + one subquery; scoring and writes untouched).

### F3 — The Start-here strip names the pick but can't decide it: no Vet/Kill on the strip

- Evidence: `renderStartHere` (`public/app.js:103-111`) renders money, capital, next action, then a single `<button id="start-here-open">Open in drawer</button>`. The `vetOpportunity`/`killOpportunity` handlers it could reuse already exist (`:224-260`) and are already reused by the drawer (`:460-462`).
- Why it costs money: the strip is the only surface shaped like a sub-minute decision, but the fastest path still costs a drawer round-trip (fetch, scroll, find Vet). One inline tap-pair removes that trip for exactly the row ranked most worthy of attention.
- Fix: show Vet/Kill buttons on the strip when the top pick carries `UNREVIEWED`, reusing the review handlers plus the existing refresh; vetted picks keep the strip as-is. Static tests for shown/hidden + handler reuse. Touch `public/app.js`, `public/dashboard.test.mjs`.
- Size S. Risk: low (reuses proven handlers; no new API shape).

### F4 — Starting an experiment costs a modal round-trip; the concrete $0 starter sits `planned`

- Evidence: board cards carry zero action buttons (`public/app.js:339-345`); the only start path is card → drawer → Update → modal → status → save (`:450`, `:664-713`). The API needs no extra input to start — `running` auto-stamps `started_at` (`functions/api/[[path]].js:299`, `:251`). Live: `planned:2/running:0`. The concrete zero-spend starter already exists in-repo: 'Spec-ad sprint: 10 brands, 10 free ads' (`d1/seed.sql:67-71`) — cost `$0 + 10 hours`, metric `replies; pilots closed`, target `>=3 replies; >=1 pilot at >=$500`, first step "Pick 1 niche (supplements). Generate 10 spec ads…" (`d1/seed.sql:29`); produces its number within 14 days of starting.
- Why it costs money: starting is the money move and it takes 5+ clicks across three surfaces; nothing has ever started (zero running in every snapshot). The experiment to run is already written — the friction is the UI, plus a human pressing start.
- Fix: one-click Start on `planned` cards (token-gated `PATCH status=running`, orphaned cards excluded); keep won/lost gated on result + post-mortem; name the spec-ad sprint as the experiment to start (human presses it — starting is a human decision, just a cheaper one now). API + static tests. Touch `public/app.js`, `public/dashboard.test.mjs`, `functions/api/api.test.mjs`.
- Size S. Risk: low-medium (first one-click status write from the board; narrow to `planned → running` only).

### F5 — The outcome ledger records the verdict but omits the money

- Evidence: the create-path ledger line is `"…" + status + ": " + oneLine` (`functions/api/[[path]].js:268-275`) and the update-path line is `` `[${day} outcome] Experiment "…" ${status}: ${oneLine}` `` (`:310-317`) — neither includes `revenue_cents`/`spent_cents`, though both are in scope at each site. The permanent notes record of a `won` experiment never states what it made or spent.
- Why it costs money: the ledger is the durable money record (health windows expire after 7d); without amounts it degrades to another status line, and the "closed experiment's money is real" bar fails exactly where it should hold.
- Fix: append `+$X revenue / -$Y spent` (fixed-2dp, same idiom as `moneyCents`, `public/app.js:51`) to both ledger lines, omitting zero legs; API tests pin the format on create-close and PATCH-close. Touch `functions/api/[[path]].js`, `functions/api/api.test.mjs`.
- Size S. Risk: low (append-only string change; scores and closure rules untouched).

### F6 — Revenue has an amount and a date but no source, so it stays unverifiable

- Evidence: the `experiments` table has no revenue-source column (`d1/schema.sql:48-68`); board cards show a bare `$X rev` (`public/app.js:342`); health sums cents only (`functions/api/[[path]].js:354`); `ended_at` supplies the date (`:305`) but nothing names the payer or channel.
- Why it costs money: "$500 revenue" with no source is a claim, not a fact — the owner's bar is amount + date + source, and the third leg is missing everywhere it would be recorded or displayed.
- Fix: additive migration `d1/migrate-2026-09-20-revenue-source.sql` (`revenue_source TEXT NOT NULL DEFAULT ''`, following the cents-migration pattern deploy tolerates on re-run, `deploy/deploy.sh:34-38`); API create/update accept ≤120 chars; board card shows `via {source}`; F5's ledger line includes it. Tests for migration-shape, API round-trip, and old-row (empty source) display. Touch `d1/migrate-2026-09-20-revenue-source.sql`, `functions/api/[[path]].js`, `public/app.js`, both test files.
- Size M. Risk: low-medium (additive migration defaults empty; old rows and reads unaffected).

### F7 — The queue has no top-drain: the worker adds rows but can never retire its own stale proposals

- Evidence: `new` inserts are unconditional (`worker/src/index.js:251-275`) — no queue-depth check; "The agent never moves status." (`README.md:72`; `worker/src/index.js:4-5`). The 30d signal sweep (`:195-199`) bounds signal backlog, but nothing equivalent exists for agent proposals: inflow without outflow, oldest now 6.7d.
- Why it costs money: every proposal the owner will never review still costs triage attention implicitly (queue length, oldest-age pressure) and dilutes the review chip's signal. A bounded, self-draining top is what lets the queue shrink without him.
- Fix: narrow, written-down rule (README + code comment): on cron ticks, rows that are `source='agent'` AND still `UNREVIEWED` AND `created_at` older than 30d flip to `killed` with a notes line `[date auto-retire] rule: unreviewed agent proposal older than 30d; reopen by flipping status back`. Reversible (status flip + reason preserved; killed rows stay listed per `README.md:64`); counted in the run log; worker test pins the predicate. Honest scope note: fires on nothing today (oldest 6.7d) — it prevents the next wedge, it doesn't clear this one. Touch `worker/src/index.js`, `worker/src/index.test.js`, `README.md`.
- Size M. Risk: medium (first worker status move ever; keep the predicate to the three conjuncts and never touch human rows).

### F8 — Orphaned experiments can never reach a decision from the UI (round-3 F7, carried)

- Evidence: `LEFT JOIN` keeps dangling rows with `orphaned:true` (`functions/api/[[path]].js:217-228`); the board renders an `orphaned` pill but the click dead-ends in `toast("Orphaned experiment — its opportunity was deleted.")` (`public/app.js:348-349`); the router has no DELETE (`:337-407`, GET/POST/PATCH/PUT only) and schema FKs are advisory without `PRAGMA foreign_keys` (`d1/schema.sql:50`).
- Why it costs money: orphans can never become won/lost from any UI path, so they pollute experiment counts and leak the lane metric (decisions/week) with rows no human action can close.
- Fix: admin-only `DELETE /api/experiments/:id` (same `authed` + 404 shape as update) with a `Delete` button on orphaned cards only, behind the token check with a confirm; keep the toast for non-admins. API tests for 401/404/happy-path. Touch `functions/api/[[path]].js`, `public/app.js`, `functions/api/api.test.mjs`.
- Size M. Risk: medium (first DELETE endpoint; restrict to experiments, never cascade to opportunities).

## 5. What NOT to change

- Scoring formula: `score = 100 * (value * confidence * fit) / (effort + 1)`, inputs 1–10 (`README.md:56`; `worker/src/lib.js:15-16`). F1 adds estimate inputs; it never changes the math.
- Human-owns-status, except the one written F7 rule: "The agent never moves status." (`README.md:72`); "The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed)." (`worker/src/index.js:4-5`). F7's auto-retire is the single exception, and only because the rule is written down and the move is reversible.
- Manual-triage-only + briefs-on-cron: "Manual `Run triage now (briefs on cron)` collects and triages only (`POST /run` 202 carries `briefs_skipped:true`); briefs land on cron ticks" (`README.md:77`; `worker/src/index.js:174`). F1/F7 must preserve the manual skip.
- Killed-with-learning: "Killed strategies stay on the board with their post-mortem — that is the point." (`README.md:64`); "Closing an experiment as `won`/`lost` requires `result` + `post_mortem`" (`README.md:74`). F4 keeps the closure gate; F8 deletes orphaned *experiments*, never killed opportunities.
- Capped humility + honest display: proposals "enter as `researching` with an `UNREVIEWED` marker in notes and an effective score capped to ≤6000 until a human vets them" (`README.md:65`); "rows without a brief carry a 'no brief' pill" (`README.md:78`). Vet/kill stay human (F3 only moves the buttons).
- Never-auto-applied rescore: "offers a suggested ±1 value/confidence rescore the human applies with one click — never auto-applied" (`README.md:74`; `public/app.js:480-490`).
- Read-only warnings: badges "flag status mismatches read-only — the human still owns every status move" (`README.md:79`).
- Seed-vs-live accounting: "Seed runs once on an empty table; live count = 12 seeds + agent proposals + manual adds." (`README.md:83`); deploy's seed-if-empty stays (`deploy/deploy.sh:30-47`).
- Auth split and secrets: "Reads are public. Writes require `Authorization: Bearer <ADMIN_TOKEN>`." (`functions/api/[[path]].js:1-2`); "No expiry; rotate manually when shared or leaked." (`README.md:88`).
- Never invent a revenue figure and never mark an experiment decided without evidence: no finding fabricates amounts (F5/F6 only record human-entered cents) and none auto-closes experiments.
- Anything needing a login, payment, or human judgment: vetting the 11 `UNREVIEWED` rows, `researching → testing → scaling` moves, pressing Start on the spec-ad sprint, post-mortems, niches/pricing/outreach, token rotation. The most valuable move on the lane metric remains non-code: a human vetting the 11 oldest-first and starting one `planned` experiment.
- Live surfaces already compliant (light palette, favicon + theme-color, brand mark, guard test green) — do not restyle, re-palette, or re-icon. Round-3 Task 4 (Priority stall nudge) stays unbuilt per the stop-adding-visibility directive.
- Carried polish, intentionally not findings: update-path string bounds, worker `!==` token compare, and the §3 dead-code/duplication list move no lane number; fix opportunistically, never as the headline.

## 6. Proposed next tasks (2–4)

### Task 1: Agent proposals arrive with $/mo, capital, and time-to-first-$ estimates

- Owned files: `worker/src/index.js`, `worker/src/index.test.js`, `README.md`.
- Acceptance: (a) triage verdict schema includes the four money keys and the INSERT persists them; (b) missing/malformed keys default safely (0/0/''/'') and low > high is clamped, never 500s; (c) notes tagged "agent estimates — correct on vet"; (d) the written README rule names the fields and their reversibility; (e) worker tests pin schema + clamps + insert; (f) `npm test` green; (g) no extra AI calls, no status moves, manual `briefs_skipped:true` intact.

### Task 2: Review rows show capital, source, and next action inline, no drawer needed

- Owned files: `public/app.js`, `functions/api/[[path]].js`, `public/dashboard.test.mjs`, `functions/api/api.test.mjs`.
- Acceptance: (a) each review row shows `Capital: …`, a source link, and a `Next: …` line from the brief excerpt; (b) excerpt is null-safe and hidden when the row has no brief; (c) ledger order, scoring, and writes untouched; (d) dashboard + API static tests lock the line and the null case; (e) `npm test` green.

### Task 3: One-click Start on planned experiment cards; spec-ad sprint named to start

- Owned files: `public/app.js`, `public/dashboard.test.mjs`, `functions/api/api.test.mjs`.
- Acceptance: (a) `planned` cards show Start (token-gated; orphaned cards excluded); (b) one click PATCHes `running` and `started_at` stamps; (c) won/lost still require result + post-mortem; (d) tests cover Start happy-path, 401 without token, orphan exclusion; (e) `npm test` green; (f) the spec-ad sprint (`d1/seed.sql:67-71`) is the documented first candidate — a human still presses it.

### Task 4: Outcome ledger and board state revenue amount with its source

- Owned files: `d1/migrate-2026-09-20-revenue-source.sql`, `functions/api/[[path]].js`, `public/app.js`, `functions/api/api.test.mjs`, `public/dashboard.test.mjs`.
- Acceptance: (a) additive migration adds `revenue_source` (default `''`; re-run tolerated by `deploy/deploy.sh:34-38`); (b) both ledger lines (create-close, PATCH-close) carry `+$X revenue / -$Y spent` and `via {source}`; (c) board cards show the amount with source; (d) old rows (empty source, zero cents) render unchanged; (e) API + dashboard tests pin all of it; (f) `npm test` green; (g) no invented figures — only human-entered cents are ever displayed.
