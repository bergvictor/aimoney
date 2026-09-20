# AUDIT 2026-09-20 — aimoney (round 1, overnight lane)

Clone HEAD: `e1c0018` (round 3: experiment money, inline post-mortems, slug-collision supports). Live rev (`_night/live/aimoney_pages_dev_api_health.html`): `e1c0018` — live is current with HEAD this round; the round-3 deploy gap is closed. No repo-local `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING.md`; governed by `README.md` plus standing rules. Working tree arrived CRLF-dirty on all 31 tracked files (pre-existing checkout artifact: `git diff --stat` shows 6715+/6715−, i.e. line endings only; content untouched, left alone).
Lane metric right now (live payload, measured): **0 decisions/week, 0 vetted/week, $0.00 revenue/week, 11 unreviewed (oldest 163.3h ≈ 6.8d), 19/27 rows without a brief, 2 planned / 0 running experiments, 0 vetted-without-experiment, last ok run 1.6h ago**.
Surfaces judgment: live HTML is text-identical to `public/index.html` (5514 served bytes vs 5635 here = exactly 121 CRLF bytes over 121 lines). Light palette only (`public/styles.css:4` `color-scheme: light`; regex search for `prefers-color-scheme|data-theme|toggleTheme|setTheme` across served files returns nothing), favicon + `theme-color` (`public/index.html:9-10`, `public/favicon.svg` 285 bytes), inline brand mark (`public/index.html:16`), guard tests green. **Zero surface-rule findings this round.**

## 1. What this project is and how it runs

- Purpose: AIMoney Lab — a ranked board of AI-money opportunities with evidence briefs and experiments (`README.md:1-15`).
- Entry points: dashboard `public/app.js` + `public/index.html`; API `functions/api/[[path]].js`; agent `worker/src/index.js` + `worker/src/lib.js`.
- Live surfaces: `https://aimoney.pages.dev`, `/api/health`, research worker (`README.md:27-31`).
- Scheduled jobs: worker cron every 6h (`worker/wrangler.toml:8-9`); manual triage-only `POST /run` 202 with `briefs_skipped:true` (`worker/src/index.js:497-506`).
- Deploys: `./deploy/deploy.sh` (D1 schema+migrations+seed-if-empty, stamp `release.json`, Pages, worker), `./deploy/verify.sh` gates rollout (≤12h freshness).

## 2. End-to-end walk-through

1. Collect: cron tick → `runResearch(env,"cron")` (`worker/src/index.js:165` via `scheduled` at `:440-443`) fans out HN/Reddit/GitHub (`:200`, `:47`, `:71`, `:95`), batch-inserts signals with `INSERT OR IGNORE` (`:205-210`).
2. Sweep + take: 30d-stale signals → noise with count (`:218-224`); oldest 6 unprocessed taken (`:225-227`). Quiet ticks continue to the brief pass (`:228-231`) instead of early-returning.
3. Triage: one Mistral NDJSON pass over top-60 list + fresh signals (`:237-254`); `new` inserts capped `UNREVIEWED` rows (`:275-299`, humility clamp `:280-281`, cap via `effectiveScore` in `worker/src/lib.js:29-32`), slug collisions link as supports (`:300-312`), `supports` appends evidence newest-kept (`:313-321`), else noise (`:322-324`); bad actions still mark processed (`:265-267`).
4. Brief: one bare row (top-scored, or oldest-unreviewed past 48h, `:331-345`) + one extra oldest bare row past 48h on cron (`:386-430`); empty/malformed brief JSON skipped silently (`:369`, `:380`, `:416`, `:427`). Manual runs always skip (`:198` `briefDeadline=-1`).
5. Serve: `GET /api/opportunities` returns `effectiveScore`-capped rows with `brief_first_steps` excerpts (`functions/api/[[path]].js:56-69`); review queue oldest-first (`:42-55`); health carries queue + money counters (`:349-383`).
6. Decide: review rows show capital/next/source with inline Vet/Kill (`public/app.js:164-206`); Start-here strip shows #1 actionable pick with Vet/Kill when unreviewed (`:95-130`); drawer holds facts/brief/experiments with money + ended date (`:543-591`, `:571`).
7. Test: `researching → testing` by hand; experiment `planned → running` one click (`:385-397`), `→ won/lost` one click + one inline line (`:404-421`); closure rules + cents + outcome ledger (`functions/api/[[path]].js:235-334`); drawer suggests a ±1 rescore, never auto-applied (`public/app.js:603-613`).
8. Where it breaks/goes silent, in order: **(a)** the human vet bottleneck — 11 unreviewed, oldest 163.3h, zero vetted this week, and the review row still hides the brief summary behind the drawer (F1); **(b)** 19/27 bare while proposals (≤6/run) structurally outrun briefs (≤2/run) (F3); **(c)** cross-source duplicate signals consume take slots and AI with no deterministic dedupe (F2); **(d)** orphaned experiment cards dead-end in a toast with no DELETE anywhere (`public/app.js:472`) (F7).

## 3. Health signals measured here

- `npm test` (this checkout, exit 0): **148 pass / 0 fail, 54 suites, duration_ms 771.207052**. Only warnings are the known `MODULE_TYPELESS_PACKAGE_JSON` reparsing notes (x3: `[[path]].js`, `index.test.js`, `lib.test.js`) and sandbox proxy notes. (Round-3 baseline was 137/50; the +11 are the shipped round-3 suites.)
- `python3 -m compileall`: N/A — repo contains zero `*.py` files (glob `**/*.py` search returns nothing; JS-only: Pages + Functions + Worker, `node --test` suites).
- Dead code (all still present): `BRIEF_DEADLINE_MS` defined but never referenced (`worker/src/index.js:20` vs live `briefDeadline` at `:198`); unused `scoreOf` import (`:139`, no other use in file); redundant double `await finish("ok")` (`:431-432`); `GITHUB_QUERIES.slice(0, 2)` silently drops `ai-side-project` (`:115` vs `:27`); `appendKeepNewest` has zero production callers (`worker/src/lib.js:36-39`, tests only).
- Duplicated logic: classify prompt text duplicated between the pass (`worker/src/index.js:237-247`) and `/debug-classify` (`:477-485`); brief-prompt + brief-insert duplicated for main (`:351-380`) and extra (`:402-426`) briefs; create-vs-update string bounds differ (create slices, update stores raw); worker token compare repeated 3x (`:454`, `:469`, `:500`).
- TODO density: **0** — regex search for `TODO|FIXME|HACK|XXX` across `public/`, `functions/`, `worker/`, `scripts/`, `deploy/` returns nothing.

## 4. Ranked findings (max 8)

### F1 — The 60-second vet still needs the drawer: review rows hide the brief summary

- Evidence: the list SELECT returns only `brief_first_steps` (`functions/api/[[path]].js:59` `(SELECT b.first_steps ... LIMIT 1) AS brief_first_steps`), and the decision line renders just that first line plus capital and source: `` const parts = [`Capital: ${esc(o.capital_needed || "—")}`]; if (next) parts.push(`Next: ${esc(next)}`); `` (`public/app.js:164-173`). The brief `summary`/`risks`/`numbers` load only via a second round-trip: `const d = await api(`/api/opportunities/${id}`);` (`public/app.js:545`).
- Why it costs money: vetting the 11 unreviewed rows (oldest 6.8d) is the entire lane metric, and the one thing a vet decision depends on — what the evidence actually says — is behind a drawer tap plus a fetch on a phone. The `Next:` action tells the owner what to do, not whether the idea is real.
- Fix: add the latest brief `summary` (first ~200 chars, null-safe like `brief_first_steps`) to the list SELECT, and render it as one muted line under the decision line; rows without a brief keep an explicit "No brief yet" so bare rows read as unproven, not empty. Touch `functions/api/[[path]].js`, `functions/api/api.test.mjs`, `public/app.js`, `public/dashboard.test.mjs`.
- Size S. Risk: low (read-only display + one SELECT column; scoring, writes, and brief versioning untouched).

### F2 — Cross-source duplicate signals eat take slots and AI; exact-URL matches need no model

- Evidence: dedupe is only `UNIQUE(source, external_id)` (`d1/schema.sql:82`) enforced by `INSERT OR IGNORE` (`worker/src/index.js:206-209`) — but each source mints its own id namespace (`hnSignals` uses `h.objectID` at `:58`, `redditSignals` uses `d.id` at `:82`), so the same story URL arriving via HN and Reddit inserts twice, takes two of the 6 oldest-first slots (`:225-227`), and burns classify attention (`:250-254`) that a string compare could have resolved.
- Why it costs money: every duplicate that reaches the model is a take slot stolen from a genuinely fresh signal and pressure toward a duplicate `new` row the owner must later vet or kill; the queue stops draining at the top.
- Fix: write the rule down (`README.md`: "a fresh signal whose URL exactly matches an existing opportunity `source_url` or an already-linked signal URL is linked as supports before triage — reversible, notes newest-kept, no status move, no AI call") and implement it as a pre-pass over the 6 taken signals reusing the existing supports SQL (`:313-321`). Worker test pins link-not-triage. Touch `worker/src/index.js`, `worker/src/index.test.js`, `README.md`.
- Size S. Risk: low (exact-URL match only, no fuzzy matching; AI budget and manual skip untouched).

### F3 — Proposal throughput (≤6 new/run) still structurally exceeds brief throughput (≤2/run)

- Evidence: `const MAX_AI_SIGNALS = 6;` (`worker/src/index.js:15`), take `ORDER BY id ASC LIMIT ?` (`:225-227`), one insert per `new` verdict with no per-run counter (`:275-299`) — up to 6 new bare rows per 6h tick. Briefs cap at 2 per cron tick (main `:346-381` + extra `:386-430`, extra gated on >48h backlog), and manual runs brief nothing (`:198`, `:505` `briefs_skipped:true`). Live: `bare_without_brief: 19` of 27 with `oldest_unreviewed_age_h: 163.3`. (Carried from round 3; that round shipped money/drawer/collision instead.)
- Why it costs money: every unbriefed row renders a `no brief` pill (`public/app.js:910-913`) and the review decision line loses its `Next:` action (`:164-173`), so the rows most needing a fast decision carry the least evidence. Whenever triage adds more than 2 per tick, the backlog grows no matter how healthy the agent looks.
- Fix: cap `new` inserts at 2 per run (matching brief capacity); when the cap binds, leave the remaining `new`-verdict signals unprocessed (`processed=0`) so a later tick retries them via the oldest-first retake — the 30d sweep (`:218-224`) still bounds the backlog. Document the rule in `README.md`; worker test pins cap + retake. Touch `worker/src/index.js`, `worker/src/index.test.js`, `README.md`.
- Size M. Risk: medium (touches the insert loop; keep noise/supports paths, AI budget, and manual skip untouched; retries cost one classify call per tick until drained).

### F4 — Agent evidence appends bump `updated_at`, inflating the vetted-this-week count

- Evidence: both agent appends set `updated_at` to now: the slug-collision path (`` `UPDATE opportunities SET notes = substr(notes || ?, -8000), updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?` ``, `worker/src/index.js:308`) and the supports path (`:317-321`, same SET clause). But `vetted_last_7d` counts `notes LIKE '%vetted]%' AND updated_at >= ... '-7 days'` (`functions/api/[[path]].js:361`) — so a row vetted a month ago that receives one supporting signal today counts as "vetted this week" with no human involved.
- Why it costs money: `vetted_last_7d` is half the lane metric ("vetted proposals that become experiments"), and today agent activity can move it. The count is documented as "touched in 7d" (`README.md:75`), yet the header presents it as `N vetted this week` (`public/app.js:438`) — the presentation promises a human decision the query cannot guarantee.
- Fix: drop the `updated_at` bump from the two worker append statements (notes still appended newest-kept), so `updated_at` again means "last human or insert touch" and the vetted window regains integrity; alternatively count from the `[YYYY-MM-DD vetted]` tag date. Worker/API test pins a supports-append to a vetted row leaving `vetted_last_7d` unchanged. Touch `worker/src/index.js`, `worker/src/index.test.js`, `functions/api/api.test.mjs`, `README.md` (one line).
- Size S. Risk: low-medium (changes `sort=updated` ordering for agent-touched rows; no status, scoring, or closure change).

### F5 — Closed-experiment money vanishes after 7 days: no lifetime totals anywhere

- Evidence: the only money aggregate is the 7d window: `SELECT COALESCE(SUM(revenue_cents),0) ... WHERE status IN ('won','lost') AND ended_at >= ... '-7 days'` (`functions/api/[[path]].js:360`), shown as `$X revenue this week` (`public/app.js:439`). A search for `revenue|SUM(` in the API confirms no lifetime total. A $500 pilot won 8 days ago survives only as one notes-ledger line (`:272-279`, `:315-322`) — the header, health, and board all read $0 again.
- Why it costs money: criterion (4) is money made real — an amount, a date, a source. The round-3 ledger work put all three on each close; without lifetime totals the lane's money number still resets to zero every week by construction, and "as much money as possible" has no running scoreboard.
- Fix: add `revenue_total` + `spent_total` (cents, all `won`/`lost`, no date bound) to `/api/health` from the existing columns — no migration — and append `· $X lifetime` to the experiments header next to the weekly figure, hidden when the keys are absent (same old-backend guard as `:431`). Touch `functions/api/[[path]].js`, `functions/api/api.test.mjs`, `public/app.js`, `public/dashboard.test.mjs`.
- Size S. Risk: low (additive read-only counters; closure gates and cents math untouched).

### F6 — The concrete zero-spend experiment exists and was never started: the spec-ad sprint

- Evidence: seed holds one planned experiment — `'Spec-ad sprint: 10 brands, 10 free ads'`, hypothesis `If we send 10 DTC supplement brands a finished spec ad each, at least 1 replies and 1 converts to a paid pilot within 14 days.`, `'planned', '$0 + 10 hours', '', 'replies; pilots closed', '>=3 replies; >=1 pilot at >=$500'` (`d1/seed.sql:67-71`). Live: `"experiments_by_status":{"planned":2}`, no `running`, `decisions_last_7d:0`. One-click Start exists (`public/app.js:385-397`). The second planned experiment's identity is not in repo data (added live by agent or human).
- Why it costs money: this is the lane's cheapest decision — $0, 10 hours, a count (replies) within 7 days and a paid pilot (>= $500) within 14 — and it has sat in `planned` while decisions stayed zero across five snapshots. No code stands in the way; only a press.
- Fix: human action, no code — press Start on the spec-ad sprint, ship 10 free spec ads to DTC supplement brands by day 2, count replies on day 7, close `won` (set `revenue_cents` from any pilot deposit, never invented) or `lost` with the one-line post-mortem. If the second live `planned` experiment duplicates it, Lose the weaker one first with one line.
- Size S. Risk: low (10 hours + $0; reversible — a `lost` close appends learning to the parent notes).

### F7 — Orphaned experiments still have no remediation path; no DELETE anywhere (carried)

- Evidence: `LEFT JOIN` keeps dangling rows with `orphaned:true` (`functions/api/[[path]].js:220-232`); the board renders an `orphaned` pill (`public/app.js:461`) but the click dead-ends: `if (c.dataset.orphan === "1") return toast("Orphaned experiment — its opportunity was deleted.");` (`:472`); search for `DELETE` in `functions/api/[[path]].js` returns zero lines, and schema FKs are advisory without `PRAGMA foreign_keys` (`d1/schema.sql:48`).
- Why it costs users/trust: orphans accumulate with no admin action — no delete, no relink, not even a drawer — slowly filling the board with unactionable cards that pollute the experiment counts the lane metric reads.
- Fix: admin-only `DELETE /api/experiments/:id` (same `authed` + 404 shape as update) with a `Delete` button on orphaned cards only, behind the token check with a confirm; keep the toast for non-admins. API tests for 401/404/happy-path. Touch `functions/api/[[path]].js`, `public/app.js`, `functions/api/api.test.mjs`.
- Size M. Risk: medium (first DELETE endpoint; restrict to experiments, never cascade to opportunities).

### F8 — Unbounded update strings + worker auth/dead-code drift (carried, polish last)

- Evidence: `createOpportunity` slices every string (`functions/api/[[path]].js:91-106`) but `updateOpportunity` stores raw (`:129-132`, `next[f] = String(b[f])`, no slice on any of eight fields); same split on experiments (create `:266-271` vs update `:291-294`). Worker still `!==`-compares tokens in three places (`worker/src/index.js:454`, `:469`, `:500`, collapsing unset-token 503 into 401) vs the API constant-time compare (`functions/api/[[path]].js:24-32`); dead items from §3 all survive.
- Why it costs trust/maintainability: a single `PATCH` with a megabyte `title` passes every guard `POST` enforces (ledger rendering, notes-idiom bloat); the next editor tunes the wrong deadline constant or "fixes" the dropped GitHub query. No direct money movement — ranked last.
- Fix: mirror create-path `slice()` bounds into both update handlers with two truncation tests; extract the constant-time compare into `worker/src/lib.js`, align worker 503/401, delete the redundant first `finish("ok")`, delete-or-wire `BRIEF_DEADLINE_MS`, drop `scoreOf` from the worker import, document `appendKeepNewest` as a test oracle, comment `slice(0,2)`. Touch `functions/api/[[path]].js`, `functions/api/api.test.mjs`, `worker/src/lib.js`, `worker/src/index.js`.
- Size S. Risk: low (`npm test` must stay green; keep tokens out of logs).

## 5. What NOT to change

- Scoring formula: `score = 100 * (value * confidence * fit) / (effort + 1)`, each input 1–10 (`README.md:56`; `worker/src/lib.js:15-16`). F1–F8 never touch the math.
- Human-owns-status: "The agent never moves status." (`README.md:72`); "The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed)." (`worker/src/index.js:4-5`). F2/F3 add linking and throttling, not decisions — no auto-vet, auto-kill, auto-start, or auto-scale.
- Manual-triage-only + briefs-on-cron: "Manual `Run triage now (briefs on cron)` collects and triages only (`POST /run` 202 carries `briefs_skipped:true`); briefs land on cron ticks" (`README.md:77`; `worker/src/index.js:505`). F3 must preserve the manual skip.
- Killed-with-learning: "Killed strategies stay on the board with their post-mortem — that is the point." (`README.md:64`); "Closing an experiment as `won`/`lost` requires `result` + `post_mortem`" (`README.md:74`). F7 deletes orphaned *experiments*, never killed opportunities.
- Capped humility + honest display: proposals "enter as `researching` with an `UNREVIEWED` marker in notes and an effective score capped to ≤6000 until a human vets them" (`README.md:65`); "rows without a brief carry a 'no brief' pill" (`README.md:78`). Vet/kill stay human.
- Never-auto-applied rescore: "offers a suggested ±1 value/confidence rescore the human applies with one click — never auto-applied" (`README.md:74`; `public/app.js:603-613`).
- Read-only warnings: badges "flag status mismatches read-only — the human still owns every status move" (`README.md:79`).
- Seed-vs-live accounting: "Seed runs once on an empty table; live count = 12 seeds + agent proposals + manual adds." (`README.md:83`); deploy's seed-if-empty stays (`deploy/deploy.sh:30-47`).
- Auth split and secrets: "Reads are public. Writes require `Authorization: Bearer <ADMIN_TOKEN>`." (`functions/api/[[path]].js:1-2`); "No expiry; rotate manually when shared or leaked." (`README.md:88`). Never invent a revenue figure; never mark an experiment decided without evidence.
- Anything needing a login, payment, or human judgment: vetting the 11 `UNREVIEWED` rows, `researching → testing → scaling` moves, starting the 2 `planned` experiments (F6), post-mortems, niches/pricing/outreach, token rotation. The most valuable moves on the lane metric remain non-code: press Start on the spec-ad sprint (F6), then vet the 11 (helped by Task 1).
- Live surfaces already compliant (light palette, favicon + theme-color, brand mark, guard test green) — do not restyle, re-palette, or re-icon.

## 6. Proposed next tasks (2–4)

### Task 1: Show brief summary in review rows so vet needs no drawer

- Owned files: `functions/api/[[path]].js`, `functions/api/api.test.mjs`, `public/app.js`, `public/dashboard.test.mjs`.
- Acceptance: (a) list SELECT returns a null-safe brief-summary excerpt per row; (b) review rows render it as one muted line under the decision line, "No brief yet" when bare; (c) ledger order, scoring, and writes untouched; (d) API + dashboard tests lock excerpt + rendering; (e) `npm test` green.

### Task 2: Link exact-URL duplicate signals as supports before AI triage

- Owned files: `worker/src/index.js`, `worker/src/index.test.js`, `README.md`.
- Acceptance: (a) pre-pass over taken signals links exact-URL matches as supports with no AI call; (b) rule written in README (reversible, newest-kept, no status move); (c) non-matching signals triage unchanged; (d) worker test pins link-not-triage; (e) `npm test` green; (f) AI budget, manual skip, and status rules intact.

### Task 3: Add lifetime revenue/spend totals to health and header

- Owned files: `functions/api/[[path]].js`, `functions/api/api.test.mjs`, `public/app.js`, `public/dashboard.test.mjs`.
- Acceptance: (a) `/api/health` carries `revenue_total` + `spent_total` cents over all `won`/`lost` (no migration); (b) experiments header appends lifetime figure, hidden on old backends; (c) weekly figure unchanged; (d) API + dashboard tests lock totals; (e) `npm test` green; (f) no closure-gate or cents-math change.

### Task 4: Cap new proposals per run to brief capacity with retake

- Owned files: `worker/src/index.js`, `worker/src/index.test.js`, `README.md`.
- Acceptance: (a) at most 2 `new` inserts per run; overflow signals stay `processed=0` for oldest-first retake; (b) noise/supports paths, AI budget, and manual skip untouched; (c) rule written in README; (d) worker test pins cap + retake; (e) `npm test` green.
