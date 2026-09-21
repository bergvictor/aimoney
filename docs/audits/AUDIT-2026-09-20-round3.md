# AUDIT 2026-09-20 — aimoney (round-3 file; angle: WASTE + FAILURE VISIBILITY, money-first)

Clone HEAD: `284163c` (tonight round 2: outage-honest health, tag-date vetted, src_fail/brief:failed markers).
Live rev in today's fetch (`_night/live/aimoney_pages_dev_api_health.html`): `091d6cf` — live trails HEAD by one commit, so the outage fix is built but not live (F1).
Last good stall snapshot (docs round-3 audit at `a4fdbcc`, live `d1aa266`): 27 opps, 11 unreviewed, oldest 166.3h, 19/27 bare, `{planned:2}`, all money 0. Today's file reads `db:"down"` and cannot refresh counts.
No repo-local `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING.md`; governed by `README.md` plus session standing rules. Tree arrived dirty on all tracked files (CRLF checkout artifact, content untouched, left alone). Only file created by this audit: this one. No `.env`/secrets read.
Surfaces: `_night/live/aimoney_pages_dev.html` reads text-identical to `public/index.html` (lines 1-121 match on read). Light only (`public/styles.css:4` `color-scheme: light`; regex search finds `prefers-color-scheme`/`data-theme` only in test guards), favicon + `theme-color` (`public/index.html:9-10`, 285-byte hand-written `public/favicon.svg`), inline brand mark (`public/index.html:16`), guard suite green (`public/tab-icon.test.mjs`, 5/5). Zero surface-rule findings.

## 1. What this project is and how it runs

- Purpose: AIMoney Lab — ranked AI-money opportunities with evidence briefs and experiments, re-optimized as results land (`README.md:1-15`).
- Entry points: dashboard `public/index.html` + `public/app.js`; API `functions/api/[[path]].js`; agent `worker/src/index.js` + `worker/src/lib.js`.
- Live surfaces: `https://aimoney.pages.dev`, `/api/health`, research worker (`README.md:27-31`, `deploy/public-surfaces.json:31-44`).
- Scheduled jobs: worker cron every 6h (`worker/wrangler.toml:8-9`); manual triage-only `POST /run` 202 with `briefs_skipped:true` (`worker/src/index.js:584-592`).
- Deploys: `./deploy/deploy.sh` (D1 schema+migrations+seed-if-empty, stamp `release.json`, Pages, worker), `./deploy/verify.sh` gates rollout (≤12h freshness); Pages auto-redeploys on push, worker via `.github/workflows`.

## 2. End-to-end walk-through

Signal → triage → proposal → brief → vet → experiment → close → money:

1. Collect: cron `scheduled` (`worker/src/index.js:528-529`) → `runResearch(env,"cron")` (`:197`); manual `POST /run` same pass as `"manual"` in `waitUntil` (`:591`). HN/Reddit/GitHub fan out (`:48`,`:77`,`:105` via `:232`), one batched `INSERT OR IGNORE` (`:243-248`), one post-collect heartbeat (`:249-252`, called `:262`).
2. Sweep + take: 30d-stale → noise with count (`:256-261`, failure catch silent at `:261`); oldest 6 taken (`:263-265`); exact-URL bounded `IN (≤6)` selects (`:275-286`) then sequential link writes (`:292-293`); quiet ticks continue to brief (`:298-301`, no early return).
3. Triage (only `if (fresh.length)`, `:308-329`): top-60 list (`:309-311`), one Mistral NDJSON call (`:312-328`; budget `MAX_AI_CALLS=4`, `:17`); `parseJsonLines` (`worker/src/lib.js:49-64`); strict validation (`worker/src/index.js:341-356`); `new` inserts `researching` + `UNREVIEWED` with humility clamp (`:363-364`) and capped score (`:376`), at most 2/run with overflow unprocessed (`:358`, `MAX_NEW_PER_RUN`, `:16`); slug collision links as supports (`:388-395`); `supports` appends newest-kept (`:397-405`); else noise (`:406-408`); one batch flush (`:410`).
4. Brief: cron only (`briefDeadline`, `:230`; manual `-1` always skips); oldest-unreviewed-first past 48h (`:423-430`); one Llama call (`:441-453`); parse + insert (`:454-470`, failure sets `briefFailed`, `:470`); one extra oldest bare row past 48h (`:476-516`); single finish carrying markers (`:519`).
5. Serve: `GET /api/opportunities` with `needs_review` bit + 4 correlated subqueries (`functions/api/[[path]].js:46-88`, subqueries `:66-69`); detail in 3 sequential queries (`:90-101`); batched 10-statement health with outage-nulls (`:382-393`, `:394-439`); `GET /api/meta` (`:441-447`); runs (`:359-364`).
6. Decide (all human): boot `refresh()` → `refreshTargets` (`public/app.js:1177`, `:1187-1221`); review derived client-side (`:228-234`, `:236-253`); review rows carry capital + next action + source + brief summary with Vet/Vet-&-starter/Kill (`:161-219`); Vet clears marker + `[date vetted]`, toast offers Log experiment (`:396-427`); Starter vets + POSTs prefilled planned + flips testing with Start shortcut (`:435-477`); Kill takes inline post-mortem (`:479-515`); strip reads list excerpt with Vet/Kill for unreviewed top (`:103-127`); drawer + admin zone (`:765-812`, `:837-934`).
7. Experiment: modal log with dollars→cents (`:1032-1083`); one-click Start (`:576-588`), Lose (`:595-612`), Win with inline $ + source + line (`:621-638`); API create (`functions/api/[[path]].js:253-302`) and update (`:304-357`) enforce result + post-mortem (`:327-332`), stamp `started_at`/`ended_at`, append `($X rev / $Y spent via {source})` ledger line on won/lost transition (`:337-346`); drawer suggests ±1 rescore, never auto-applied (`public/app.js:825-835`); zero-decision weeks get read-only stale nudge with deep-link (`:665-674`, `:562-569`).
8. Where it most often breaks or goes silent: (a) live trails HEAD, so today's health still lies `ok:true` + `db:"down"` (F1); (b) human funnel at zero (0 vetted/decisions, 11 unreviewed oldest 166.3h, 19/27 bare, `{planned:2}`) while the $0 spec-ad sprint (`d1/seed.sql:66-71`, `planned`, `$0 + 10 hours`, target `>=3 replies; >=1 pilot at >=$500`) sits unpressed — a human still presses Start (`public/app.js:574-575`); (c) at HEAD the review tab still reads all-clear on outage (F2) and quick closes drop spend (F3); (d) sweep failures silent (F6), signals unbounded and URL scans unindexed (F7).

## 3. Health signals measured here

- `npm test` (this Linux checkout): exit 0. Command `node --test worker/src/lib.test.js worker/src/index.test.js functions/api/api.test.mjs public/tab-icon.test.mjs public/dashboard.test.mjs` completed with exit 0; visible TAP subtests all `ok`, zero failures shown (full 64KB TAP truncated to 40KB by tooling; a follow-up summary script was approval-denied, so per-run totals below are from the committed baseline). Baseline `_night/tests-baseline.log` (Windows, exit 0): 233 tests, 81 suites, 233 pass, 0 fail, `duration_ms 533.0518`. Only warnings: `MODULE_TYPELESS_PACKAGE_JSON` reparsing notes.
- `python3 -m compileall`: N/A — zero `*.py` files (glob `**/*.py` search returns nothing; JS-only repo). Python appears only as JSON one-liners in `deploy/deploy.sh:41` and `deploy/verify.sh:39,43,51`.
- `node --check`: not run as a separate shell check (further shell approvals stalled); parse of every source is proven by the green suite that imports them (`functions/api/api.test.mjs:6` imports the API router; worker and dashboard suites import their sources).
- TODO density: 0 — regex `TODO|FIXME|XXX|HACK` across `public/`, `functions/`, `worker/`, `scripts/`, `deploy/`, `d1/` returns nothing.
- Dead code (verified present at HEAD): `BRIEF_DEADLINE_MS` sole occurrence (`worker/src/index.js:21`; live gate is `briefDeadline`, `:230`); unused `scoreOf` import name (`:155`, sole use in file); five unreachable toast gates (`public/app.js:412,494,579,598,624`, each self-commented superseded at `:411,493,578,597,623`); `GITHUB_QUERIES` third entry `"ai-side-project"` (`worker/src/index.js:28`) excluded by `.slice(0, 2)` (`:128`); dead ternary `:324` (`!fresh.length ? [] : …` inside `if (fresh.length)`); comment-only `if (!fresh.length) {}` (`:298-301`); `appendKeepNewest` zero production callers (`worker/src/lib.js:36-39`, tests only).
- Duplicated logic: `clamp10` API (`functions/api/[[path]].js:16-20`) vs `worker/src/lib.js:4-7`; classify prompt pass (`worker/src/index.js:312-322`) vs `/debug-classify` (`:563-572`); brief prompt+insert main (`:444-467`) vs extra (`:488-511`); `inlinePostMortem` (`public/app.js:284-322`) vs `inlineWinClose` (`:328-390`); `centsDollars` (API `:24`) vs `moneyCents` (app.js `:53`, intentional commented mirror); `UNREVIEWED` literals in API/worker/app vs exported `UNREVIEWED_MARKER` used only inside `worker/src/lib.js:21-31`; vetted tag string-coupled (`[date vetted]` written `public/app.js:416`, counted `functions/api/[[path]].js:390`); `deriveReviewList` (`public/app.js:233-234`) inlines `isNeedsReview` (`:228-231`); worker token compare 3x (`worker/src/index.js:539-541,554-556,585-587`) vs API constant-time (`functions/api/[[path]].js:28-36`); three `#board` listeners (`public/app.js:1088,1097,1106`).
- Live surfaces: saved HTML reads text-identical to `public/index.html`; surface rules all pass (see preamble), zero findings. Live health today: `{"ok":true,"rev":"091d6cf","db":"down","opportunities":0,"unreviewed":0,"bare_without_brief":0,"experiments_by_status":{},"hours_since_last_ok_run":null,"oldest_unreviewed_age_h":null,"decisions_last_7d":0,"revenue_last_7d":0,"revenue_total":0,"spent_total":0,"vetted_last_7d":0,"vetted_no_experiment":0,"noise_24h":0,"time":"2026-09-21T00:07:34.912Z"}` — `ok:true` during `db:"down"` because live predates HEAD's fix.

## 4. Ranked findings (max 8)

Money-first basis, in numbers, from the repo's own data:

1. Money produced to date: $0.00. Last krone arrived: never — none. Evidence: live health `revenue_total:0`, `revenue_last_7d:0` (today and last good snapshot); `d1/seed.sql:66-71` seeds one `planned` experiment with no cents; zero `won`/`lost` rows ever (`experiments_by_status:{}` today, `{planned:2}` last good).
2. Single step between now and the next payment: send the 10 finished spec ads to 10 real DTC supplement brands (`d1/seed.sql:68-71`; target `>=3 replies; >=1 pilot at >=$500`). The next payment is the first ≥$500 pilot.
3. Measured conversion at that step right now: 0 attempts, 0 successes, all-time — no experiment has ever left `planned` (`decisions_last_7d:0`, `vetted_last_7d:0` across snapshots).

Lane metric (aimoney): decisions/week 0; vetted→experiments 0; unreviewed 11, oldest 166.3h (last good; today's file is outage-zeroed).

No finding below moves question 2 directly — no code change can send the spec ads for the owner. Ranked instead by what keeps the money and backlog reads honest (F1-F3), then per-tap/per-tick waste (F4-F7), then dead rails (F8). The list-JOIN rewrite (4 correlated subqueries × 200 rows, `functions/api/[[path]].js:66-69`) is deferred again: medium risk on the hottest read with no live D1 to prove the win. No surface-rule findings.

**F1 — Live trails HEAD by the outage-honesty fix, so today's health still lies `ok:true` with `db:"down"`.**
Evidence: live `"rev":"091d6cf"` vs HEAD `284163c` (`git log --oneline -12`); gap is exactly tonight round 2 (outage-nulls, tag-date vetted, failure markers). Live file: `"ok":true,"rev":"091d6cf","db":"down"` with `revenue_total:0`, `decisions_last_7d:0`. HEAD code returns `ok:false` with null counters on batch failure (`functions/api/[[path]].js:394-439`); live runs the old unconditional `ok:true`.
Why it costs money and trust: every money and funnel counter reads 0 during an outage, indistinguishable from the true stall, and `deploy/verify.sh:32` greps `'"ok":true'`, so the deploy gate passes while down.
Fix (operator, no code): merge/deploy HEAD (`284163c`) via `./deploy/deploy.sh` (additive migrations tolerated, seed-if-empty guards live rows), then `./deploy/verify.sh` including the ≤12h freshness gate. Touch no repo files. Size S. Risk: low.

**F2 — Review tab reads "all clear" during an outage: failed fetch empties the list and the empty-state has no failure check.**
Evidence: `public/app.js:1202` (`api("/api/opportunities?limit=200").catch(() => { state.apiFailures.push("/api/opportunities"); return { opportunities: [] }; })`) then `:1207` (`if (opps) state.opportunities = opps.opportunities || [];`) overwrites with `[]`; `:236-253` derives 0 review rows; `:206` renders `` `Review queue empty — every agent proposal has been vetted or killed.` `` with no `apiFailures` check, unlike the ledger empty-state at `:149-151` which checks. HEAD's health null-fix does not cover this path.
Why it costs money: the 11-deep backlog paints as `Needs review (0)` plus an all-clear tab exactly when the owner checks during an outage.
Fix: on opportunities fetch failure keep stale `state.opportunities` instead of overwriting with `[]`, and give the review empty-state the same `apiFailures` check + retry wording as the ledger. Touch `public/app.js`, `public/dashboard.test.mjs`. Size S. Risk: low — read-only render plus stale-keep.

**F3 — One-click Win/Lose drop spend (Lose drops revenue too), so quick closes under-record money.**
Evidence: `public/app.js:603-605` (lose sends `{ status: "lost", result, post_mortem }`, no cents); `:629-631` (win sends `{ status: "won", result, post_mortem, revenue_cents, revenue_source }`, no `spent_cents`); modal sends both at `:1070-1072`. The ledger line renders from row cents (`functions/api/[[path]].js:340-342`, `($X rev / $Y spent)`), so quick closes always show `$0.00 spent`.
Why it costs money: spend burned on a quick close vanishes; `spent_total` under-counts and ROI cannot be computed from closed rows.
Fix: add an optional spend-$ input to `inlineWinClose` and the Lose inline row, clamped like the modal (`Math.max(0, Math.round(Number(v) * 100) || 0)`), sent as `spent_cents`; empty stays 0 for truly $0 closes. Touch `public/app.js`, `public/dashboard.test.mjs`. Size S. Risk: low — additive inputs, API already clamps.

**F4 — Detail endpoint does 3 sequential queries; every Vet/Kill/Starter pays it and discards briefs + experiments.**
Evidence: `functions/api/[[path]].js:91-99` awaits opportunity, then briefs (`LIMIT 5`), then experiments; `public/app.js:402,440,484` GET detail first for writes, using only `d.opportunity.notes` (`:404,:442,:486`). One phone tap costs 3 sequential detail round-trips plus PATCH, list, and health.
Why it costs money: the sub-minute clear pays avoidable latency and discarded kilobytes on the exact taps repeated 11+ times to drain the queue.
Fix: serve the three detail SELECTs as one `env.DB.batch` (byte-identical `{ opportunity, briefs, experiments }`), and add `?only=notes` returning just `{ opportunity }` for the write-path prefetches; vet/kill/starter use it. Touch `functions/api/[[path]].js`, `public/app.js`, `functions/api/api.test.mjs`, `public/dashboard.test.mjs`. Size M. Risk: low-medium — read-only batching plus an additive param, both pinned in tests.

**F5 — Exact-URL pre-pass still does up to 12 sequential D1 writes with a swallowed evidence failure.**
Evidence: `worker/src/index.js:292-293` (`await …UPDATE signals…run(); await …UPDATE opportunities…run().catch(() => null);`) per match, up to 6 matches, while the verdict loop batches at `:410` (`if (verdictWrites.length) await env.DB.batch(verdictWrites);`). Up to 12 round-trips inside the 30s `waitUntil` budget (`:7-11`).
Why it costs money: match-heavy ticks burn the wall-clock the pass is engineered for; the `.catch(() => null)` hides evidence-append failures.
Fix: accumulate pre-pass signal-UPDATEs and notes-appends into `verdictWrites` (or a sibling array flushed with it) instead of awaiting inline; keep `exactUrlTarget` matching and the no-status-move rule. Touch `worker/src/index.js`, `worker/src/index.test.js`. Size S. Risk: low — same statements, batch semantics already accepted.

**F6 — Stale-sweep failure is swallowed with no marker while the take depends on the sweep.**
Evidence: `worker/src/index.js:256-261` (`try { …UPDATE signals SET processed = 1 … '-30 days'… } catch { /* stale sweep failed; triage proceeds anyway */ }`); the finish-ok line at `:519` carries `brief:`/`stale:`/`src_fail:`/`brief:failed` but nothing for sweep failure. The oldest-first take at `:263-265` wedges when ancient rows are never swept.
Why it costs money: a systematically failing sweep reads as green `ok` runs while the queue top chokes on pre-deploy backlog.
Fix: on sweep catch, append `sweep:failed` to the finish-ok error line (same suffix idiom as `brief:failed`); keep skip-and-proceed. Touch `worker/src/index.js`, `worker/src/index.test.js`. Size S. Risk: low — log-text only on the failure path.

**F7 — Signals table grows forever, URL matches are unindexed, and collection inserts 72/run for 6 slots.**
Evidence: no `DELETE` in worker or API (regex search empty); sweep marks noise but never deletes (`worker/src/index.js:256-261`); pre-pass bounded `IN` queries (`:280-285`) scan without indexes (`d1/schema.sql:28-29,85` cover status/score, category, processed/created_at only — no `source_url`/`url`); `MAX_SIGNALS_PER_SOURCE=8` (`:14`) × 9 fetches feeds one batch insert (`:243-248`) for a 6-row take (`:263-265`).
Why it costs money: every-6h fetch + insert for rows that queue then sweep to noise, plus unbounded growth taxing the sweep and pre-pass scans.
Fix: add retention `DELETE` gated on all three predicates (`processed = 1 AND opportunity_id IS NULL AND created_at` older than 90d; linked-evidence and unprocessed rows never touched) plus `CREATE INDEX` on `opportunities.source_url` and `signals.url` via `d1/schema.sql` and a new `d1/migrate-*.sql`; document beside the sweep rule in `README.md`. Touch `worker/src/index.js`, `worker/src/index.test.js`, `d1/schema.sql`, new migration, `README.md`. Size M. Risk: low-medium — it is a DELETE, so pin all three predicates in a test; indexes are additive.

**F8 — Dead safety rails ship alongside a token-gate inconsistency (Add/Log/Run toast vs modal).**
Evidence: `BRIEF_DEADLINE_MS` (`worker/src/index.js:21`, sole occurrence; live gate `briefDeadline`, `:230`); `scoreOf` import name (`:155`); five dead toast gates (`public/app.js:412,494,579,598,624`, each behind `openAdminModal` and self-commented superseded); third GitHub query (`:28`) cut by `.slice(0, 2)` (`:128`); dead ternary (`:324`); empty `if` (`:298-301`); Add/Log-experiment/Run-triage toast on missing token (`public/app.js:985,1033,1115`) while Vet/Kill/Start/Lose/Win/Starter open the admin modal (`:400,410,448,482,492,577,596,622`).
Why it costs trust: readers believe an unenforced deadline and unreachable gates protect them; phone taps on Add/Log/Run hit a dead-end toast instead of the token field.
Fix: delete the constant, import name, five dead gates, dead ternary, and empty `if`; resolve the GitHub slice-or-string mismatch (fetch all three or drop the third string); route the three toast gates through `openAdminModal` with the same subnote pattern. Touch `worker/src/index.js`, `public/app.js`, `public/dashboard.test.mjs` only where a guard counted removed lines. Size S. Risk: low.

## 5. What NOT to change

- Scoring math and honest cap: `score = 100 * (value * confidence * fit) / (effort + 1)` (`README.md:56`, `worker/src/lib.js:15-16`) with `UNREVIEWED` rows clamped to ≤6000 (`worker/src/lib.js:29-32`). Make reads honest and fewer, not the math different.
- "The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed)." (`worker/src/index.js:4-5`; also `README.md:72`: "`researching → testing` is a human decision".)
- "No auto-transitions — the human still owns every status move." (`public/app.js:664`.) Start/Win/Lose/Vet/Kill stay human-pressed, including the spec-ad sprint (`public/app.js:574-575`: "a human still presses it").
- "Killed strategies stay on the board with their post-mortem — that is the point." (`README.md:63-64`.) Never delete killed rows or notes; F7 deletes only unlinked noise signals.
- Closure gate: `won`/`lost` require non-empty `result` + `post_mortem` (`functions/api/[[path]].js:327-332`), `ended_at` stamped. Never invent a revenue figure and never mark an experiment decided without evidence.
- Public-read / token-write split with constant-time compare (`functions/api/[[path]].js:28-36`); `ADMIN_TOKEN` rotation stays a human deploy step (`README.md:85-88`). No tokenless writes, no stored bypass.
- Idempotent deploy: schema always, seed only when empty (`deploy/deploy.sh:30-47`). Never reseed over live rows; do not touch deploy scripts, CI, data files, or secrets in these tasks.
- Manual-triage-only + briefs-on-cron (`README.md:77`; `worker/src/index.js:592`). F5-F7 preserve the manual skip.
- Anything needing a login, credential, payment, or a human decision: Cloudflare deploys, `CLOUDFLARE_API_TOKEN`, sending the spec ads, pricing a pilot, vet/kill calls, closing experiments, the 90d retention DELETE sign-off (F7 needs the owner's explicit confirm). This audit changed no code and read no secrets.

## 6. Proposed next tasks (2–4)

Prerequisite (operator, not code): F1 — deploy HEAD `284163c` and run `./deploy/verify.sh`, so the already-built outage honesty reaches live. The list-JOIN rewrite stays deferred (medium risk on the hottest read, unprovable without live D1).

### Task 1: Review tab shows failure, not all-clear; Add/Log/Run open token modal

- Owned files: `public/app.js`, `public/dashboard.test.mjs`.
- Acceptance: (a) failed opportunities fetch keeps stale list and the review empty-state shows the failure + Retry wording like the ledger, never the vetted-or-killed all-clear; (b) Add-opportunity, Log-experiment, and Run-triage with no token open the admin modal with a subnote instead of a toast; (c) chip count/age/tooltip and success-path renders unchanged; (d) new tests pin the stale-keep, the failure empty-state, and the three modal gates; (e) `npm test` green.

### Task 2: One-click Win/Lose capture optional spend like the modal

- Owned files: `public/app.js`, `public/dashboard.test.mjs`.
- Acceptance: (a) Win inline row has optional spend $ beside revenue $ + source + line and sends `spent_cents` clamped exactly like the modal; Lose inline row has optional spend $; (b) empty/bad/negative spend clamps to 0 and renders exactly as today for $0 rows; (c) outcome-ledger line and board/drawer money figures unchanged for $0 closes; (d) new tests pin send + clamp + render; (e) `npm test` green.

### Task 3: Batch detail and pre-pass D1; vet prefetches notes only

- Owned files: `functions/api/[[path]].js`, `public/app.js`, `worker/src/index.js`, `functions/api/api.test.mjs`, `worker/src/index.test.js`, `public/dashboard.test.mjs`.
- Acceptance: (a) `GET /api/opportunities/:id` serves its three SELECTs in one `env.DB.batch` with a byte-identical payload; (b) `?only=notes` returns just `{ opportunity }` and Vet/Vet-&-starter/Kill prefetch through it; (c) pre-pass signal + notes writes flush in the verdict batch with no inline awaits; matching, inflow cap, AI budget, and no-status-move rules unchanged; (d) new tests pin single-batch behavior and the notes-only shape; (e) `npm test` green.

### Task 4: Retain noise 90d with URL indexes; mark sweep failures; sweep dead code

- Owned files: `worker/src/index.js`, `worker/src/index.test.js`, `d1/schema.sql`, new `d1/migrate-*.sql`, `README.md`, `public/app.js`.
- Acceptance: (a) retention deletes only `processed = 1 AND opportunity_id IS NULL AND created_at` older than 90d (owner confirms the DELETE first); linked-evidence and unprocessed rows untouched; (b) additive indexes on `opportunities.source_url` and `signals.url` with an idempotent migration; (c) sweep failure records `sweep:failed` on the finish-ok line, keeping proceed-anyway; (d) `BRIEF_DEADLINE_MS`, the `scoreOf` import name, five dead toast gates, dead ternary, empty `if`, and the GitHub slice mismatch are gone; `README.md` documents retention beside the sweep rule; (e) `npm test` green.
