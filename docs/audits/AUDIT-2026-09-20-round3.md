# AUDIT 2026-09-20 — aimoney (round 3, overnight lane)

Clone HEAD: `ed2c9db` (round 2: strip Vet/Kill, one-click Lose, tolerant zero-spend). Live rev (`_night/live/aimoney_pages_dev_api_health.html`): `7d3be4a` (round 1) — one commit behind HEAD, but now carrying `revenue_last_7d`.
Lane metric right now (live payload): **0 decisions/week, 0 vetted/week, $0.00 revenue/week (measured, key present), 11 unreviewed (oldest 161.9h ≈ 6.7d), 19/27 rows without a brief, 2 planned / 0 running experiments, 0 vetted-without-experiment**.
No repo-local `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING.md` exists; governed by `README.md` plus the standing rules. Working tree arrived CRLF-dirty on every file (pre-existing checkout artifact; content untouched — see `git diff .gitignore`).
Surfaces judgment: live HTML is text-identical to `public/index.html` (`cmp` differs at byte 16 only — this checkout's CRLF vs served LF). Light palette only (`public/styles.css:4` `color-scheme: light`; no dark branch outside guard tests), favicon + `theme-color` (`public/index.html:9-10`, `public/favicon.svg` 285 bytes), inline brand mark (`public/index.html:16`), guard tests green. **Zero surface-rule findings this round.**

## 1. What this project is and how it runs

- Purpose: AIMoney Lab — a ranked board of AI-money opportunities with evidence briefs and experiments (`README.md:1-15`).
- Entry points: dashboard `public/app.js` + `public/index.html`; API `functions/api/[[path]].js`; agent `worker/src/index.js`.
- Live surfaces: `https://aimoney.pages.dev`, `/api/health`, research worker (`README.md:27-31`, `deploy/public-surfaces.json:31-44`).
- Scheduled jobs: worker cron every 6h (`worker/wrangler.toml:8-9`); manual triage-only `POST /run` 202 with `briefs_skipped:true` (`worker/src/index.js:487-496`).
- Deploys: `./deploy/deploy.sh` (D1 schema+migrations+seed-if-empty, stamp `release.json`, Pages, worker), `./deploy/verify.sh` gates rollout (≤12h freshness).

## 2. End-to-end walk-through

1. Collect: cron tick → `runResearch(env,"cron")` (`worker/src/index.js:165` via `430-433`) fans out HN/Reddit/GitHub (`:200`, `:47`, `:71`, `:95`), batch-inserts signals (`:205-210`).
2. Sweep + take: 30d-stale signals → noise with count (`:218-224`); oldest 6 unprocessed taken (`:225-227`). Quiet ticks now continue to the brief pass (`:228-231`) instead of early-returning.
3. Triage: one Mistral NDJSON pass over top-60 list + fresh signals (`:234-254`); `new` inserts capped `UNREVIEWED` rows (`:275-302`, humility clamp `:280-281`, cap via `effectiveScore` in `worker/src/lib.js:29-32`), `supports` appends evidence newest-kept (`:303-311`), else noise (`:312-314`); bad actions still mark processed (`:265-267`).
4. Brief: one bare row (top-scored, or oldest-unreviewed past 48h, `:321-335`) + one extra oldest bare row past 48h on cron (`:376-420`); empty/malformed brief JSON skipped silently (`:359`, `:370`, `:406`, `:417`). Manual runs always skip (`:198` `briefDeadline=-1`).
5. Serve: `GET /api/opportunities` returns `effectiveScore`-capped rows with `brief_first_steps` excerpts (`functions/api/[[path]].js:53-66`); review queue oldest-first (`:43-51`); health carries queue + money counters (`:344-378`).
6. Decide: review rows show capital/next/source with inline Vet/Kill (`public/app.js:164-206`); Start-here strip shows #1 actionable pick with Vet/Kill when unreviewed (`:95-130`); drawer holds facts/brief/experiments (`:485-532`).
7. Test: `researching → testing` by hand; experiment `planned → running` one click (`:334-344`), `→ won/lost` one click + one prompt line (`:351-363`); closure rules + cents + outcome ledger (`functions/api/[[path]].js:232-329`); drawer suggests a ±1 rescore, never auto-applied (`public/app.js:545-555`).
8. Where it breaks/goes silent, in order: **(a)** live is one deploy behind HEAD (`7d3be4a` vs `ed2c9db`), so the newest one-click tools are not live; **(b)** the human vet bottleneck — 11 unreviewed, oldest 161.9h, zero vetted this week; **(c)** 19/27 bare while proposals (≤6/run) structurally outrun briefs (≤2/run); **(d)** slug-collision proposals silently dropped (`worker/src/index.js:300-302`); **(e)** orphaned experiment cards dead-end in a toast (`public/app.js:414`).

## 3. Health signals measured here

- `npm test` (this Linux checkout, exit 0): **137 pass / 0 fail, 50 suites, duration_ms 1343.45** — same 137/50 as the Windows baseline (`_night/tests-baseline.log`, 255.56ms there; slower here is environment, not regression). Only warnings are the known `MODULE_TYPELESS_PACKAGE_JSON` reparsing notes (x3) and sandbox proxy notes.
- `python3 -m compileall`: N/A — repo contains zero `*.py` files (glob `**/*.py` search returned nothing; JS-only: Pages + Functions + Worker, `node --test` suites).
- Dead code (all still present): `BRIEF_DEADLINE_MS` never referenced (`worker/src/index.js:20` vs live `briefDeadline` at `:198`); unused `scoreOf` import (`:139`, no other use in file); redundant double `await finish("ok")` (`:421-422`); `GITHUB_QUERIES.slice(0,2)` silently drops `ai-side-project` (`:115` vs `:27`); `appendKeepNewest` has zero production callers (`worker/src/lib.js:36-39`, tests only).
- Duplicated logic: classify prompt text duplicated between the pass (`worker/src/index.js:237-247`) and `/debug-classify` (`:466-475`); brief-prompt + brief-insert duplicated for main (`:344-368`) and extra (`:392-415`) briefs; create-vs-update string bounds differ (see F8); worker token compare repeated 3x (`:442-444`, `:457-459`, `:488-490`).
- TODO density: **0** — regex search for `TODO|FIXME|HACK|XXX` across `public/`, `functions/`, `worker/` returns nothing. No dark-mode markers (`prefers-color-scheme`, `data-theme`) outside the guard tests that forbid them.

## 4. Ranked findings (max 8)

### F1 — Live is one deploy behind HEAD, so the newest one-click tools are not live

- Evidence: live `_night/live/aimoney_pages_dev_api_health.html` reads `"rev":"7d3be4a"` (with `revenue_last_7d:0`, so the revenue round landed); clone HEAD is `ed2c9db` ("strip Vet/Kill, one-click Lose, tolerant zero-spend filter", `git log`). Live therefore lacks the strip Vet/Kill (`public/app.js:112-120`), one-click Lose (`:351-363`, `:407`), and the tolerant zero-spend match (`:80-81`).
- Why it costs money: the exact buttons that let the owner clear a row or close an experiment from his phone do not exist on the live board; every prior round's stall (0 decisions, 0 vetted) was measured against a board missing its newest drain tools.
- Fix: operator run only — `./deploy/deploy.sh` (additive migration already applied; stamps rev) then `./deploy/verify.sh` including the ≤12h freshness gate (live `hours_since_last_ok_run:0.3`, so the gate passes). No code edits. Touch nothing in the repo.
- Size S. Risk: low (no schema change pending; seed-if-empty guards live rows, `deploy/deploy.sh:30-47`).

### F2 — Closed-experiment money is missing from the drawer and the outcome ledger (amount without a home)

- Evidence: drawer experiment cards render `name/hypothesis/status/result/post_mortem` but no cents and no date (`public/app.js:509-516`, `<div class="meta">${statusPill(e.status)}<span …>${esc(e.result || e.target || "")}</span></div>`), while board cards do show `moneyCents` figures (`:403`). The outcome-ledger line appended to parent notes carries date + name + status but no figures: `const line = "[" + day + " outcome] Experiment " + … + status + ": " + oneLine;` (`functions/api/[[path]].js:272`, same shape at `:314`).
- Why it costs money: the lane's money number (`revenue_last_7d`, now live and $0.00) is produced by closes the owner reviews in the drawer and the notes ledger — the two places that never show an amount, date, or source together, so a closed experiment's money never becomes real.
- Fix: include `revenue_cents`/`spent_cents` as `$X rev / $Y spent` in both ledger appends (create `:269-276` and update `:307-318`), and render `moneyCents` + `ended_at` on drawer cards next to the existing result line. API tests for the ledger format, dashboard static tests for the drawer figures. Touch `functions/api/[[path]].js`, `functions/api/api.test.mjs`, `public/app.js`, `public/dashboard.test.mjs`.
- Size M. Risk: low (additive display + ledger text; scoring, closure gates, and cents math untouched).

### F3 — Two phone frictions block the 60-second clear: token toast dead-ends and blocking prompt() post-mortems

- Evidence: all four gated handlers dead-end on a toast — `if (!state.token) return toast("Enter the admin token first.");` (`public/app.js:250` vet, `:268` kill, `:335` start, `:352` lose) — while the token modal opens only from the Admin button (`:661-679`, bound solely to `#btn-admin`). Kill and Lose then demand a blocking native dialog: `const pm = prompt("One-line post-mortem (required to kill):");` (`:269`, same at `:595`; Lose at `:353`), which on a phone hides all context and punishes typos with a full retry.
- Why it costs money: vetting the 11 unreviewed rows (oldest 6.7d) and closing the 2 planned experiments is the entire lane metric, and every one of those taps starts with either a dead-end toast (find Admin, enter token, re-tap) or a context-free prompt. Each friction is small; multiplied across 11+2 decisions it is the bottleneck.
- Fix: when the token is missing, open the admin modal directly (same `showModal` block, keep the toast text as its subnote) instead of toasting; replace the three `prompt()` calls with an inline one-line input row in the review-actions / drawer / Lose flow where empty still cancels and the API closure gate stays unchanged. Dashboard static tests for modal-open and inline-input cancel/submit. Touch `public/app.js`, `public/dashboard.test.mjs`.
- Size M. Risk: low-medium (touches all three close paths; keep the `result`+`post_mortem` API gate and the 401-without-token behavior intact).

### F4 — Slug-collision proposals are silently dropped instead of attached as supporting evidence

- Evidence: the `new`-verdict insert sits in try/catch, and the catch swallows everything: `} catch { await env.DB.prepare("UPDATE signals SET processed=1 WHERE id=?").bind(sig.id).run(); }` (`worker/src/index.js:300-302`) — processed with no `opportunity_id`, distinguishable from real noise only by absence. The normal `supports` path right below links + appends evidence (`:303-311`).
- Why it costs money: a duplicate proposal is free corroborating evidence for an existing row; today it vanishes (no link, no notes line), so the queue neither drains at the top nor gets stronger — and a human re-vetting the row never sees the second source.
- Fix: write the rule down (`README.md`: "on slug collision the worker links the signal to the existing row as supports — reversible, notes newest-kept, no status move") and implement it: on collision, look up the existing id by slug, `UPDATE signals SET processed=1, opportunity_id=?`, and append the same `[signal date]` line via the existing `substr(notes || ?, -8000)` idiom. Worker test pins link-not-drop. Touch `worker/src/index.js`, `worker/src/index.test.js`, `README.md`.
- Size S. Risk: low (reuses the proven supports SQL; no status moves, no new AI calls).

### F5 — Proposal throughput (≤6 new/run) structurally exceeds brief throughput (≤2/run): 19 bare rows cannot drain

- Evidence: `const MAX_AI_SIGNALS = 6;` (`worker/src/index.js:15`), take `ORDER BY id ASC LIMIT ?` (`:225-227`), one insert per `new` verdict (`:275-302`) — up to 6 new bare rows per 6h tick. Briefs cap at 2 per cron tick (main `:336-371` + extra `:376-420`, extra gated on >48h backlog), and manual runs brief nothing (`:198`, `:495` `briefs_skipped:true`). Live: `bare_without_brief: 19` of 27 with `oldest_unreviewed_age_h: 161.9`.
- Why it costs money: every unbriefed row renders a `no brief` pill (`public/app.js:829-832`) and the review decision line loses its `Next:` action (`:165-173`), so the rows most needing a fast decision carry the least evidence. Whenever triage adds more than 2 per tick, the backlog grows no matter how healthy the agent looks.
- Fix: cap `new` inserts at 2 per run (matching brief capacity); when the cap binds, leave the remaining `new`-verdict signals unprocessed (`processed=0`) so a later tick retries them via the oldest-first retake — the 30d sweep (`:218-224`) still bounds the backlog. Document the rule in `README.md`; worker test pins cap + retake. Touch `worker/src/index.js`, `worker/src/index.test.js`, `README.md`.
- Size M. Risk: medium (touches the insert loop; keep noise/supports paths, AI budget, and manual skip untouched; retries cost one classify call per tick until drained).

### F6 — The concrete zero-spend experiment exists and was never started: the spec-ad sprint

- Evidence: seed holds one planned experiment — `'Spec-ad sprint: 10 brands, 10 free ads'`, hypothesis `If we send 10 DTC supplement brands a finished spec ad each, at least 1 replies and 1 converts to a paid pilot within 14 days.`, `'planned', '$0 + 10 hours', '', 'replies; pilots closed', '>=3 replies; >=1 pilot at >=$500'` (`d1/seed.sql:67-71`). Live: `"experiments_by_status":{"planned":2}`, no `running`, `decisions_last_7d:0`. One-click Start exists (`public/app.js:334-344`). The second planned experiment's identity is not in repo data (seed holds one; it was added live by agent or human).
- Why it costs money: this is the lane's cheapest decision — $0, 10 hours, a count (replies) within 7 days and a paid pilot (>= $500) within 14 — and it has sat in `planned` while decisions stayed zero across four snapshots. No code stands in the way; only a press.
- Fix: human action, no code — press Start on the spec-ad sprint, ship 10 free spec ads to DTC supplement brands by day 2, count replies on day 7, close `won` (set `revenue_cents` from any pilot deposit, never invented) or `lost` with the one-line post-mortem. If the second live `planned` experiment duplicates it, Lose the weaker one first with one line.
- Size S. Risk: low (10 hours + $0; reversible — a `lost` close appends learning to the parent notes).

### F7 — Orphaned experiments still have no remediation path; no DELETE anywhere (carried)

- Evidence: `LEFT JOIN` keeps dangling rows with `orphaned:true` (`functions/api/[[path]].js:217-228`); the board renders an `orphaned` pill (`public/app.js:402`) but the click dead-ends: `if (c.dataset.orphan === "1") return toast("Orphaned experiment — its opportunity was deleted.");` (`:414`); search for `DELETE` in `functions/api/[[path]].js` returns zero lines, and schema FKs are advisory without `PRAGMA foreign_keys` (`d1/schema.sql:48`).
- Why it costs users/trust: orphans accumulate with no admin action — no delete, no relink, not even a drawer — slowly filling the board with unactionable cards that pollute the experiment counts the lane metric reads.
- Fix: admin-only `DELETE /api/experiments/:id` (same `authed` + 404 shape as update) with a `Delete` button on orphaned cards only, behind the token check with a confirm; keep the toast for non-admins. API tests for 401/404/happy-path. Touch `functions/api/[[path]].js`, `public/app.js`, `functions/api/api.test.mjs`.
- Size M. Risk: medium (first DELETE endpoint; restrict to experiments, never cascade to opportunities).

### F8 — Unbounded update strings + worker auth/dead-code drift (carried, polish last)

- Evidence: `createOpportunity` slices every string (`functions/api/[[path]].js:87-102`) but `updateOpportunity` stores raw (`:126-129`, `next[f] = String(b[f])`, no slice on any of eight fields); same split on experiments (create `:263-268` vs update `:287-290`). Worker still `!==`-compares tokens in three places (`worker/src/index.js:442-444`, `:457-459`, `:488-490`, collapsing unset-token 503 into 401) vs the API constant-time compare (`functions/api/[[path]].js:21-29`); dead items from §3 all survive.
- Why it costs trust/maintainability: a single `PATCH` with a megabyte `title` passes every guard `POST` enforces (ledger rendering, notes-idiom bloat); the next editor tunes the wrong deadline constant or "fixes" the dropped GitHub query. No direct money movement — ranked last.
- Fix: mirror create-path `slice()` bounds into both update handlers with two truncation tests; extract the constant-time compare into `worker/src/lib.js`, align worker 503/401, delete the redundant first `finish("ok")`, delete-or-wire `BRIEF_DEADLINE_MS`, drop `scoreOf` from the worker import, document `appendKeepNewest` as a test oracle, comment `slice(0,2)`. Touch `functions/api/[[path]].js`, `functions/api/api.test.mjs`, `worker/src/lib.js`, `worker/src/index.js`.
- Size S. Risk: low (`npm test` must stay green; keep tokens out of logs).

## 5. What NOT to change

- Scoring formula: `score = 100 * (value * confidence * fit) / (effort + 1)`, each input 1–10 (`README.md:56`; `worker/src/lib.js:15-16`). F1–F8 never touch the math.
- Human-owns-status: "The agent never moves status." (`README.md:72`); "The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed)." (`worker/src/index.js:4-5`). F4/F5 add linking and throttling, not decisions — no auto-vet, auto-kill, auto-start, or auto-scale.
- Manual-triage-only + briefs-on-cron: "Manual `Run triage now (briefs on cron)` collects and triages only (`POST /run` 202 carries `briefs_skipped:true`); briefs land on cron ticks" (`README.md:77`; `worker/src/index.js:495`). F5 must preserve the manual skip.
- Killed-with-learning: "Killed strategies stay on the board with their post-mortem — that is the point." (`README.md:64`); "Closing an experiment as `won`/`lost` requires `result` + `post_mortem`" (`README.md:74`). F3 keeps the post-mortem requirement (inline input, still mandatory); F7 deletes orphaned *experiments*, never killed opportunities.
- Capped humility + honest display: proposals "enter as `researching` with an `UNREVIEWED` marker in notes and an effective score capped to ≤6000 until a human vets them" (`README.md:65`); "rows without a brief carry a 'no brief' pill" (`README.md:78`). Vet/kill stay human.
- Never-auto-applied rescore: "offers a suggested ±1 value/confidence rescore the human applies with one click — never auto-applied" (`README.md:74`; `public/app.js:545-555`).
- Read-only warnings: badges "flag status mismatches read-only — the human still owns every status move" (`README.md:79`).
- Seed-vs-live accounting: "Seed runs once on an empty table; live count = 12 seeds + agent proposals + manual adds." (`README.md:83`); deploy's seed-if-empty stays (`deploy/deploy.sh:30-47`).
- Auth split and secrets: "Reads are public. Writes require `Authorization: Bearer <ADMIN_TOKEN>`." (`functions/api/[[path]].js:1-2`); "No expiry; rotate manually when shared or leaked." (`README.md:88`). F1 names the deploy; it does not perform it. Never invent a revenue figure; never mark an experiment decided without evidence.
- Anything needing a login, payment, or human judgment: vetting the 11 `UNREVIEWED` rows, `researching → testing → scaling` moves, starting the 2 `planned` experiments (F6), post-mortems, niches/pricing/outreach, token rotation. The most valuable moves on the lane metric remain non-code: deploy (F1), press Start on the spec-ad sprint (F6), then vet the 11.
- Live surfaces already compliant (light palette, favicon + theme-color, brand mark, guard test green) — do not restyle, re-palette, or re-icon.

## 6. Proposed next tasks (2–4)

### Task 1: Show closed-experiment money in drawer cards and outcome ledger lines

- Owned files: `functions/api/[[path]].js`, `functions/api/api.test.mjs`, `public/app.js`, `public/dashboard.test.mjs`.
- Acceptance: (a) both ledger appends (create + update) carry `$X rev / $Y spent` from the closed row's cents; (b) drawer experiment cards show fixed-2dp revenue/spend + `ended_at`; (c) board cards unchanged; (d) API + dashboard tests lock the format; (e) `npm test` green; (f) no scoring, closure-gate, or cents-math change.

### Task 2: Auto-open token modal on gated taps; inline post-mortem for Kill and Lose

- Owned files: `public/app.js`, `public/dashboard.test.mjs`.
- Acceptance: (a) Vet/Kill/Start/Lose without a token open the admin modal instead of dead-end toast; (b) kill (review + drawer) and Lose use an inline one-line input, empty cancels, row untouched; (c) API still 401s without token and 400s on empty close fields; (d) dashboard static tests cover modal-open + inline cancel/submit; (e) `npm test` green; (f) no API change.

### Task 3: Link slug-collision proposals as supports instead of dropping them

- Owned files: `worker/src/index.js`, `worker/src/index.test.js`, `README.md`.
- Acceptance: (a) `README.md` states the collision rule (link-as-supports, reversible, no status move); (b) collision sets the signal's `opportunity_id` to the existing row and appends the `[signal date]` evidence line; (c) no signal is marked processed-without-parent on collision; (d) worker test pins link-not-drop; (e) `npm test` green; (f) no new AI calls, no status moves.

### Task 4: Cap new proposals per run to brief capacity so the bare backlog drains

- Owned files: `worker/src/index.js`, `worker/src/index.test.js`, `README.md`.
- Acceptance: (a) at most 2 `new` inserts per run; overflow `new`-verdict signals stay unprocessed for a later tick; (b) noise/`supports` paths and verdict validation untouched; (c) manual `POST /run` still 202s with `briefs_skipped:true`; (d) 30d sweep still bounds the backlog; (e) worker test pins cap + retake; (f) `npm test` green.
