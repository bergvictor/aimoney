# AUDIT-2026-09-20-round2 (aimoney) — read-only, 2026-09-21

Read-only audit. No existing file was edited; this is the only file created. Repo has no `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING.md` (read attempts 2026-09-21 returned not-found); `README.md` is the governing doc. Working tree uses CRLF (`file public/index.html` → `with CRLF line terminators`); `git status --short` already lists 35 modified files and `git diff --stat` shows 9557/9557 whole-file churn vs `HEAD c0a1e58` before this audit — pre-existing line-ending drift, not caused here. `HEAD` is `c0a1e58` (round 1); live serves `8d9b974` (round 4, one behind HEAD).

## 1. What this project is and how it runs

- Purpose: AIMoney Lab ranks AI-money opportunities by expected value, attaches research-brief evidence, and tracks kill/scale experiments with money (revenue/spent cents + source) so decisions compound instead of restarting.
- Entry points: dashboard `public/index.html:1` + `public/app.js:1`; API `functions/api/[[path]].js:368` (`/api/health`, `/api/opportunities`, `/api/experiments`, `/api/briefs`, `/api/runs`, `/api/meta`); worker `worker/src/index.js:535` (`GET /`, `/ping-ai`, `/debug-classify`, `POST /run`, cron).
- Live surfaces: `https://aimoney.pages.dev/` (5516-byte HTML saved), `https://aimoney.pages.dev/api/health` (546-byte JSON saved), worker `https://aimoney-research.levitinvlad.workers.dev/` (`deploy/public-surfaces.json:31-44`); build identity is `/release.json` (`deploy/public-surfaces.json:32`), not `/build.json`.
- Scheduled jobs: research-worker cron `0 */6 * * *` (`worker/wrangler.toml:8-9`) → `scheduled` (`worker/src/index.js:536-537`) → collect → triage (6/run) → ≤2 proposals/run → 1+1 briefs/tick; Pages Git-connected build stamps `public/release.json` (`scripts/stamp-release.sh:5-9`).
- How it deploys: `./deploy/deploy.sh` (D1 schema + `d1/migrate-*.sql` loop + seed-once guard, stamp rev, Pages deploy, worker deploy) or CI `.github/workflows/deploy-worker.yml:27-54` (schema + migration loop + worker deploy); `./deploy/verify.sh` checks markers, live-revision equality, non-empty list, and 12h agent freshness.

## 2. End-to-end walk-through

Main flow A — signal → proposal → brief → vet → experiment → decided money.

1. Cron fires every 6h (`worker/wrangler.toml:8-9`) → `runResearch(env, "cron")` (`worker/src/index.js:195,536-537`); stuck `running` rows older than 30 min are reaped (`:199-204`).
2. Collect: `hnSignals` (`:47-74`), `redditSignals` (`:76-102`), `githubSignals` (`:104-130`) via `timedJson` with 6s body-covering timeout (`:35-45`); all-queries-failed names the source in `state.src_fail` (`:72,100,128`).
3. Signals batch-insert (`:242-245`); stale >30d swept to noise with count (`:255-259`); oldest 6 unprocessed taken (`:261-263`).
4. Exact-URL pre-pass links supports without an AI call (`:269-295` via `exactUrlTarget` in `worker/src/lib.js:166-176`); linked rows leave `fresh` so classify never sees them (`:293-294`).
5. Classify: top-60 list fetch + NDJSON prompt (`:306-320`), one `aiComplete` call (`:322-326`, budget `MAX_AI_CALLS = 4` at `:17`, timeout+fallback at `:134-151`), `parseJsonLines` (`worker/src/lib.js:62-77`); verdicts validated one-per-signal (`:339-354`).
6. `new` (≤2/run via `MAX_NEW_PER_RUN`, `:16,356`) inserts a `researching` row with `UNREVIEWED` + capped score + reversible money estimates (`:367-377`, `agentMoneyEstimates` at `:178-193`); slug collision links as supports (`:382-394`); `supports` appends newest-kept evidence (`:395-403`); verdict writes flush as one `env.DB.batch` (`:408`).
7. Brief pass: one bare row — top-scored, or oldest-unreviewed-first past 48h (`:419-434`) — plus one extra oldest-unreviewed bare row past 48h within budget (`:476-523`); empty briefs never stored (`:457`); failures recorded as `brief:failed` (`:468,521`); single finish write carries `brief:<mode> stale:N src_fail:… brief:failed` (`:527`).
8. Dashboard reads list + health: `listOpportunities` (`functions/api/[[path]].js:44-86`, `needs_review` bit + 300/200-char brief excerpts, capped rescore) and `GET /api/health` (`:374-490`, 10-statement batch `:390-402` with per-probe isolation fallback `:411-440`, partial nulls, `db` by answered-at-all `:490`).
9. Human vets on phone without the drawer: review decision line (capital + next action + source, `public/app.js:167-176`) + brief line (`:181-187`) under each row; `Vet` (`:406-435`) clears `UNREVIEWED` + appends `[YYYY-MM-DD vetted]`; `Vet & log starter` (`:443-485`) vets + POSTs a planned starter + flips to `testing`; `Kill` (`:487+`) requires a one-line post-mortem; strip `Start here today` (`:103-133`) shows the #1 pick with Vet/Kill inline.
10. Experiment lifecycle: `POST /api/experiments` (`functions/api/[[path]].js:255-304`) and `PATCH /api/experiments/:id` (`:306-359`); `running` stamps `started_at`, `won`/`lost` require `result` + `post_mortem` and stamp `ended_at`; closing appends a one-line `($X rev / $Y spent via {source})` ledger entry to the parent (`:293-302,339-348`), score untouched, drawer offers a one-click ±1 rescore the human applies.
11. Money surfaces: `revenue_last_7d` (`:396`), `revenue_total`/`spent_total` (`:397`), decisions from `ended_at` in 7d (`:464-467`); dashboard formats via `moneyCents` (`public/app.js:53`).

Main flow B — deploy → verify: push to `master` → Pages build stamps `public/release.json` (`scripts/stamp-release.sh:8`) and CI applies `d1/schema.sql` + `d1/migrate-*.sql` then deploys the worker (`.github/workflows/deploy-worker.yml:27-54`); `./deploy/verify.sh` greps markers (`:30-36`), requires live `/release.json` JSON with `revision == expected` with bounded stale retries and immediate fail on HTML/unparsable/placeholder (`:41-79`), requires a non-empty list (`:82-87`) and an ok run within 12h (`:89-97`).

Where it most often breaks or goes silent: (a) live D1 lacks `revenue_cents`/`spent_cents`/`revenue_source` so the two money probes fail and the four money fields read null (live `health_probe_failures`, detail `revenue_cents`); the schema can only converge when CI runs with secrets, which has never happened; (b) the human never vets — 11 unreviewed, oldest 171.4h, 19/27 bare, `vetted_last_7d: 0`, `decisions_last_7d: null`, 2 planned / 0 running; (c) AI/source hiccups degrade honestly (`src_fail`, `brief:failed`, timeouts) but a failed verdict-writes batch silently drops the tick's triage writes (`worker/src/index.js:408`); (d) first paint stays neutral (`…` placeholders, no hardcoded digits) so a failed refresh keeps last-good cache instead of blanking (`public/app.js:108-112,255-262`).

## 3. Health signals measured here

- Test suite (`npm test`, i.e. `node --test worker/src/lib.test.js worker/src/index.test.js functions/api/api.test.mjs d1/migrations.test.mjs deploy/deploy.test.mjs public/tab-icon.test.mjs public/dashboard.test.mjs` per `package.json:7`): exit 0. `tests 280, suites 96, pass 280, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 1168.197315`. Warnings only: `UNDICI-EHPA` experimental-proxy notice and `MODULE_TYPELESS_PACKAGE_JSON` (suggests adding `"type": "module"` to `package.json`).
- `python3 -m compileall -q` on source dirs: not applicable — zero Python sources. Glob `**/*.py` returned 0 files (positive control: same-shape glob `**/*.mjs` returned 5 test files, so the empty result is real, not a broken matcher). `python3` is still a runtime dependency of the deploy path (`deploy/deploy.sh:56-58`, `deploy/verify.sh:63,82,90` use `python3 -c` JSON parsing) — see Finding 6.
- Dead code: none material. Prior hygiene removed the unenforced deadline, unused `scoreOf` import, and unfetched GitHub query (pinned by `worker/src/index.test.js:433-449`); the odd block-scoped temp in `reviewBriefLine` (`public/app.js:182-187`) is live and covered.
- Duplicated logic: `clamp10` in both `functions/api/[[path]].js:16-20` and `worker/src/lib.js:4-7` while the API already imports `effectiveScore`/`tokensMatch` from the lib (`[[path]].js:10`) — Finding 5. Documented mirrors kept deliberately: `centsDollars` (`:24`, comment `:23`) ↔ `moneyCents` (`public/app.js:53`); classify prompt in the live pass (`worker/src/index.js:310-320`) and `/debug-classify` (`:571-580`); the D1 tolerate-list case statement duplicated between `deploy/deploy.sh:43-50` and `.github/workflows/deploy-worker.yml:41-48` and pinned verbatim by `deploy/deploy.test.mjs:121-125` — Finding 1.
- TODO density: 0 hits for regex `TODO|FIXME|XXX|HACK` across `public functions worker d1 deploy scripts`. Positive controls: regex `UNREVIEWED` returned 100+ hits and `color-scheme|prefers-color-scheme|data-theme|toggleTheme` returned the real `public/styles.css:4` declaration plus guard-test references, so the zero is absence, not a dead matcher. (An earlier literal-mode pass with `|` unescaped also returned empty — discarded as the match-nothing trap, re-run in regex mode.)
- Surface rules (all pass, zero findings): `color-scheme: light` (`public/styles.css:4`), no `prefers-color-scheme`/`data-theme`/theme-toggle string in shipped `public/` (only guard-test assertions reference them); `<link rel="icon" … href="/favicon.svg">` + `<meta name="theme-color" content="#0d6b3f">` (`public/index.html:9-10`) with hand-written 32×32 `$`-on-`#0d6b3f` `public/favicon.svg` (under 2 KB); inline brand mark reusing the same geometry/accent/glyph (`public/index.html:16`); guard suite `public/tab-icon.test.mjs:48-113` (5 tests) green. Saved live HTML matches byte-for-byte on these markers.
- Build identity: this surface publishes its revision at `/release.json` (`deploy/public-surfaces.json:32`), stamped by `scripts/stamp-release.sh:8` (Pages) and `deploy/deploy.sh:73` (manual), consumed by health `rev` (`functions/api/[[path]].js:482-489`) and gated by `deploy/verify.sh:41-79` (JSON parse + `revision == expected`, bounded stale retries, immediate fail on HTML/unparsable/`dev-undeployed`). No second source of truth is wanted. Live URL `https://aimoney.pages.dev/release.json` body: UNKNOWN — `_night/live/` contains only `aimoney_pages_dev.html` and `aimoney_pages_dev_api_health.html` (verified by `ls -la _night/live`: 2 files), and this audit runs with no network, so the live revision body could not be fetched. Do not claim verification without that fetch.
- Live numbers used below (saved `_night/live/aimoney_pages_dev_api_health.html:1`, `rev 8d9b974`, `2026-09-21T03:44:36.961Z`): `db up`, `opportunities 27`, `unreviewed 11`, `bare_without_brief 19`, `experiments_by_status {"planned":2}`, `hours_since_last_ok_run 3.7`, `oldest_unreviewed_age_h 171.4`, `decisions_last_7d null`, `revenue_last_7d null`, `revenue_total null`, `spent_total null`, `vetted_last_7d 0`, `vetted_no_experiment 0`, `noise_24h 0`, `health_probe_failures ["decisions_revenue_week","revenue_lifetime"]`, `health_probe_detail {"decisions_revenue_week":"revenue_cents","revenue_lifetime":"revenue_cents"}`.

## 4. Ranked findings (max 8)

Money-first (numbers from this project's own data, before any task): earned to date: NONE measured — `revenue_total` is null (probe failed) and `experiments_by_status` is `{planned: 2}` with zero running/won/lost, so no closed experiment exists to carry revenue; last krone arrived: NEVER. Single step to the next payment: a human runs one zero-spend starter and closes it as won with a human-entered amount + source — concretely the seeded `Spec-ad sprint: 10 brands, 10 free ads` (`d1/seed.sql:96-105`, `$0 + 10 hours`, target `>=3 replies; >=1 pilot at >=$500`) via the one-click Win row (`public/app.js:338-400`). Measured conversion at that step: UNMEASURED — 0 vetted and 0 decisions in 7d means no attempt has reached the step; no rate exists and none is projected here.

This project is a tool the owner uses to rank and test AI-money ideas, not a product he sells; rank by owner-hours saved and decisions/week, not revenue.

Lane metric (aimoney: decisions/week, vetted→experiments, backlog drained) current values: `decisions_last_7d` null (unknown — probe failed), `vetted_last_7d` 0, `vetted_no_experiment` 0, unreviewed 11 with oldest 171.4h (≈7.1d). Findings are ordered by movement on that metric. Surface-rules sweep: no findings (see §3). First-five-seconds: shipped — `Start here today` strip above the ledger (`public/index.html:42`, `public/app.js:103-133`), `Needs review (N · oldest …)` chip (`index.html:52`), mobile masthead compaction (pinned by dashboard tests); the most important truth is readable without scrolling or opening anything, so no finding is filed for it.

### F1. Live money fields are null because the migrations never applied — and CI/deploy still duplicate the loop instead of sharing one list

Evidence: live `_night/live/aimoney_pages_dev_api_health.html:1` → `"decisions_last_7d":null,"revenue_last_7d":null,"revenue_total":null,"spent_total":null` with `"health_probe_failures":["decisions_revenue_week","revenue_lifetime"]`; the only probes reading the missing columns are `functions/api/[[path]].js:396` (`COALESCE(SUM(revenue_cents),0) … ended_at >= …-7 days`) and `:397` (`SUM(revenue_cents)…SUM(spent_cents)`); the columns exist only in `d1/migrate-2026-09-20-experiment-cents.sql:5-6` (`ALTER TABLE experiments ADD COLUMN revenue_cents …`, `spent_cents …`) and `d1/migrate-2026-09-20-revenue-source.sql:5`, while `d1/schema.sql` is all `CREATE TABLE IF NOT EXISTS` (a no-op on existing tables). The apply path exists twice, by copy: `deploy/deploy.sh:37-52` (`for f in d1/migrate-*.sql … *"duplicate column"*|*"already exists"* … exit 1`) and `.github/workflows/deploy-worker.yml:33-50` (same loop), each commented only `keep both in sync` (`deploy.sh:34-36`, workflow `:31-32`); `deploy/deploy.test.mjs:121-125` pins the duplication verbatim instead of a single source.

Why it costs money/users/trust: the lane metric is blind — decisions and revenue read unknown, so the owner cannot see a win when it happens; and two hand-synced loops will drift the next time one is edited, silently re-breaking convergence.

Fix: extract one `deploy/apply-d1-migrations.sh` (sorted `d1/migrate-*.sql` glob, same tolerate-list, loud `::error::` + `exit 1` otherwise) and call it from both `deploy/deploy.sh` and the workflow step at `.github/workflows/deploy-worker.yml:33-50` (`name: Apply D1 migrations in sorted order` — that is the exact CI step a fix round changes). Extend `deploy/deploy.test.mjs` to assert both callers reference the shared script, and keep `d1/migrations.test.mjs` convergence + positive-control tests green. Owner action, not code: add `CF_API_TOKEN` + `CF_ACCOUNT_ID` to this repo's GitHub secrets and re-run the workflow — nothing reaches live D1 until then, and no credential work belongs in the fix. Size S. Risk: low (identical commands, one home; idempotent re-runs already tolerated).

### F2. Probe detail names missing columns but is blind to missing tables

Evidence: `functions/api/[[path]].js:427-429` → `const driftMsg = err instanceof Error ? err.message : String(err ?? ""); const driftMatch = /no such column:\s*([A-Za-z_][A-Za-z0-9_]*)/i.exec(driftMsg);`.

Why it costs money/users/trust: the next drift (a renamed/dropped table such as `signals` or `agent_runs`) names the probe but not the cause, sending the reader back into the source — the exact opacity the column detail just removed. Reliability angle: the overnight failure that pages least informatively is the one debugged slowest.

Fix: widen the narrow regex to `/no such (column|table):\s*([A-Za-z_][\w.]*)/i`, store the bare identifier (keep the no-SQL/no-driver-verbiage rule), and add two API tests (missing-column + missing-table) asserting the detail carries only the identifier and the body contains no `SELECT`/`SQLITE_ERROR`. Files: `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Size S. Risk: negligible.

### F3. Health `rev` is cached forever per isolate, so a redeploy can serve a stale revision

Evidence: `functions/api/[[path]].js:14` → `let cachedHealthRev = null;` and `:482-489` → `let rev = cachedHealthRev || "unknown"; … const r = cachedHealthRev ? { ok: false } : await fetch(new URL("/release.json", url.origin));`.

Why it costs money/users/trust: a long-lived isolate keeps reporting the pre-ship commit after a deploy succeeds — a wrong revision is worse than none because it reports success while lying, and it defeats the `/release.json` gate the fleet standardised on.

Fix: give the cache a TTL (re-fetch when older than ~60s) or bypass it when the request carries a cache-buster; keep single-flight within the window. Add a test that advances the clock across the TTL and asserts exactly one re-fetch per window. Files: `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Size S. Risk: low.

### F4. Brief capacity is structurally below inflow, so the bare backlog (19/27) cannot drain

Evidence: live `bare_without_brief: 19` of 27 with `oldest_unreviewed_age_h: 171.4`; `worker/src/index.js:16` → `const MAX_NEW_PER_RUN = 2;` vs one brief (`:419-469`) plus one extra only when oldest-unreviewed exceeds 48h (`:476-523`); `README.md:76` documents `at most 2 new proposals (inflow ≤ brief capacity)` but the arithmetic only balances on old-backlog ticks.

Why it costs money/users/trust: rows without briefs cannot be vetted in under a minute from a phone — the decision needs the evidence in front of it (`reviewDecisionLine`/`reviewBriefLine`, `public/app.js:167-187`) and bare rows render `No brief yet`. The queue grows faster than the evidence that drains it, so `vetted_last_7d` stays 0.

Fix: gate inflow on backlog: once per run read `bare_without_brief`, and while it exceeds 10 cap inserts to 1 for that tick — overflow `new`-verdict signals stay `processed = 0` for a later tick (already the rule at `:356`), reversible, no status move, AI budget untouched. Pin with a worker test and a one-line `README.md` update. Files: `worker/src/index.js`, `worker/src/index.test.js`, `README.md`. Size M. Risk: medium (deliberately slows queue growth; overflow is retried, never dropped). Rejected alternative: always brief 2 — breaks `MAX_AI_CALLS = 4` on classify+brief+extra ticks.

### F5. Duplicated `clamp10` between the API and the shared lib

Evidence: `functions/api/[[path]].js:16-20` keeps a local `const clamp10 = (v, dflt) => { … }` while `:10` already does `import { effectiveScore, tokensMatch } from "../../worker/src/lib.js"`, which exports its own `worker/src/lib.js:4-7` (`export const clamp10 = (v, d = 5) => { … }`).

Why it costs money/users/trust: two bounds implementations (different coercion/rounding/defaults) will diverge on the next bounds fix, silently splitting scoring from validation.

Fix: delete the local copy and extend the existing import to include `clamp10`; keep all call sites (`[[path]].js:112-113,158`) unchanged. Existing bounds tests on both sides pin the behavior. Files: `functions/api/[[path]].js`. Size S. Risk: negligible.

### F6. Deploy and verify hard-depend on `python3` with no preflight

Evidence: `deploy/deploy.sh:56-58` → `| python3 -c "import json,sys; d=json.load(sys.stdin); …"` and `deploy/verify.sh:63` (`python3 -c "import json,sys; print(json.load(sys.stdin).get('revision',''))"`), `:82`, `:90` (same inline pattern).

Why it costs money/users/trust: on a host without `python3` the seed-guard measurement fails opaquely mid-rollout (the guard aborts closed — correct but cryptic), and inline `-c` strands the Windows approval adapter per standing worker rules. Reliability angle: this is the unattended step most likely to fail with the least helpful message.

Fix: add an early `command -v python3 || { echo "<script>: python3 not found (JSON parsing)"; exit 1; }` preflight to both scripts so the failure is named before any D1 write; keep the parsing itself unchanged. Assert the preflight in `deploy/deploy.test.mjs`. Files: `deploy/deploy.sh`, `deploy/verify.sh`, `deploy/deploy.test.mjs`. Size S. Risk: negligible.

### F7. The committed `public/release.json` is a placeholder revision

Evidence: `public/release.json:1` → `{"project":"aimoney","revision":"dev-undeployed","built_at":"2026-09-14T00:00:00Z"}`; the stampers are `scripts/stamp-release.sh:5-9` and `deploy/deploy.sh:72-74`; the backstop is `deploy/verify.sh:67-68` (`FAIL live-revision: placeholder revision dev-undeployed`).

Why it costs money/users/trust: any build that skips the stamp step serves a revision claiming a deploy while lying; verify catches it, but the committed artifact itself is the lie and every fresh clone starts from it.

Fix: stop committing the stamp output — ignore `public/release.json` (it is a build artifact) and rely on the two existing stamp paths; keep the verify placeholder gate as the backstop. Assert ignored-or-absent-from-git in `deploy/deploy.test.mjs`. Files: `.gitignore`, `deploy/deploy.test.mjs`. Size S. Risk: low (preview builds without a stamp now fail loudly instead of serving the placeholder).

### F8. Worker verdict-writes batch has no isolation fallback — the shape health just fixed

Evidence: `worker/src/index.js:408` → `if (verdictWrites.length) await env.DB.batch(verdictWrites);` with the comment at `:333-337` admitting `A failed batch loses this tick's verdict writes (signals stay unprocessed, retried next tick) — the same tradeoff round 2's health batching already accepted.`

Why it costs money/users/trust: one bad verdict write (e.g. a future migration skew) discards the whole tick's triage decisions; `added`/`updated` under-report and signals churn a tick late — silent, overnight, unattended.

Fix: wrap the batch in try/catch; on reject, re-run the writes individually with per-statement try/catch, count applied vs failed in `state`, and surface the failed count in the finish message alongside `src_fail` (`:527`). Keep signals-unprocessed-on-total-failure. Success path stays one batch. Files: `worker/src/index.js`, `worker/src/index.test.js`. Size M. Risk: low (failure path only).

## 5. What NOT to change

- The agent proposes; the human owns status. `worker/src/index.js:4-5`: `The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed).` `README.md:72`: `researching → testing is a human decision: flip to testing when you start a real experiment … The agent never moves status.` No auto-vet, auto-kill, auto-start, or auto-close — however slow the queue looks.
- Unreviewed humility cap. `worker/src/lib.js:18-22`: `while a row carries the UNREVIEWED marker its EFFECTIVE score is clamped below the human seeds that matter` (`UNREVIEWED_SCORE_CAP = 6000`). `README.md:65`: `effective score capped to ≤6000 until a human vets them`. Do not lift or re-tune the cap without the owner.
- Killed rows stay listed. `README.md:64`: `Killed strategies stay on the board with their post-mortem — that is the point.` Never delete or hide them.
- Outcomes never auto-rescore. `functions/api/[[path]].js:335-338`: `Score untouched — the drawer offers a suggested rescore the human applies with one click.` `README.md:74`: `never auto-applied`. Never invent a revenue figure and never mark an experiment decided without evidence.
- Writes need the admin token by design. `functions/api/[[path]].js:30`: `writes disabled (ADMIN_TOKEN not set)`. Rotation lives in `README.md:85-88` (Pages env + worker secret + dashboard re-entry) and needs the owner.
- Live database and credentials need the owner: adding `CF_API_TOKEN`/`CF_ACCOUNT_ID` repo secrets, any `wrangler d1 execute --remote`, and any migration against live D1. The orchestrator has already listed these for him; do not run, enter, print, or store secrets.
- Platform terms and money honesty stand as written: no captcha solving, fabricated reviews/receipts, account creation, false certification/customer claims, forbidden scraping/messaging, or financial advice/implied return. Counts that did not run stay `null`, never `0` (`functions/api/[[path]].js:446-450`).

## 6. Proposed next tasks (2–4)

Money-first recap for ordering: earned `none`, last krone `never`, next payment needs one human-closed won with amount + source, conversion `unmeasured`. Task 1 is first because it makes the next deploy converge the schema by itself, turning the four null money fields (and the blind lane metric) into numbers the moment the owner adds secrets — the most valuable safe change available.

1. Share one D1 migration script between CI and deploy.sh
   Owned files: `deploy/apply-d1-migrations.sh` (new), `deploy/deploy.sh`, `.github/workflows/deploy-worker.yml` (`:33-50`), `deploy/deploy.test.mjs`.
   Acceptance: both callers invoke the shared script; sorted order kept; second run is a clean duplicate-column no-op; a genuinely broken migration exits 1 with the driver error surfaced; `npm test` green including the updated verbatim/shared-reference assertions.

2. Name missing tables in health probe detail, not just columns
   Owned files: `functions/api/[[path]].js` (`:425-429`), `functions/api/api.test.mjs`.
   Acceptance: a `no such table: X` probe failure yields detail `X` with no `SELECT`/`SQLITE_ERROR` in the body; the existing missing-column test still passes; partial payload keeps `ok:true`, `db:"up"`, and the `verify.sh` marker.

3. Cap new proposals at 1/run while bare-without-brief backlog exceeds 10
   Owned files: `worker/src/index.js`, `worker/src/index.test.js`, `README.md`.
   Acceptance: a tick with bare backlog >10 inserts at most 1 proposal and leaves overflow `processed = 0`; `MAX_AI_CALLS`, verdict validation, no-status-move, and manual `briefs_skipped` disclosure unchanged; README documents the gate in one line.

4. Give the health rev cache a 60s TTL so redeploys show promptly
   Owned files: `functions/api/[[path]].js` (`:14,482-489`), `functions/api/api.test.mjs`.
   Acceptance: two health calls inside the TTL fetch once; advancing the clock past the TTL re-fetches exactly once; cache-busted requests never serve a stale pinned revision; existing rev-cache test updated, suite green.
