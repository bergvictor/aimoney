# Audit 2026-09-20 round 4 — aimoney (read-only)

Clone root: `/root/coding-projects/_workspace/trackb-aimoney-r4`. HEAD `d4262cd`, tree clean before this file (`git status --short` empty); no network, no installs, no edits to existing files. Only this file created. Never read `.env`/secrets/tokens.

## 1. What this project is and how it runs

- Purpose: AIMoney Lab — ranked AI-money opportunities with research briefs and experiments; the agent proposes, a human vets and tests.
- Entry points: `public/index.html` + `public/app.js` (dashboard), `functions/api/[[path]].js` (D1-backed REST API), `worker/src/index.js` (research agent).
- Live surfaces: `https://aimoney.pages.dev/` (+ `/api/health`, `/api/opportunities`, `/api/runs`), worker `https://aimoney-research.levitinvlad.workers.dev/`; live rev `af7f6d4`, one commit behind HEAD `d4262cd`.
- Scheduled jobs: worker cron `0 */6 * * *` (`worker/wrangler.toml:9`, collect + triage + briefs) and manual `POST /run` (202, triage-only, `briefs_skipped:true`, `worker/src/index.js:710-721`).
- Deploys: Pages Git-connected (`public/` + `scripts/stamp-release.sh`) plus CI `.github/workflows/deploy-worker.yml` (schema + shared migrations + worker) or manual `deploy/deploy.sh`, gated by `deploy/verify.sh`.

## 2. End-to-end walk-through

Signal to decision; the hop where it most often goes silent is hop 13.

1. Collect: `worker/src/index.js:49` `hnSignals`, `:78` `redditSignals`, `:106` `githubSignals` via `timedJson` (`:37`, 6s timeout covering the body read). All-queries-failed names the source in `src_fail`.
2. Store: `:354-359` one batched `INSERT OR IGNORE INTO signals`, then heartbeat `:360-363` (`phase:collected`).
3. Sweep: `:367-372` unprocessed signals older than 30d become noise (`stale:N`).
4. Take: `:374-376` oldest-first `LIMIT 6` (`MAX_AI_SIGNALS`, `:15`).
5. Exact-URL pre-pass (no AI): `:385-413` via pure `exactUrlTarget` (`:168`); bounded `IN` selects (`:391-401`); a match links as supports (notes newest-kept, no status move); a failed link is skipped and counted (`prepass:N_failed`), never thrown.
6. Gates, read before classify: `:425-429` bare-without-brief > 10 caps inserts to 1/tick; `:430-433` unreviewed > 10 pauses inflow to 0/tick. Overflow new-verdicts stay `processed = 0`.
7. Classify (one AI pass): `:444-457` runs only with fresh signals AND `maxNewThisRun > 0`; `buildClassifyPrompt` (`:272`) + `aiComplete` (`:136`), parsed by `parseJsonLines` (`worker/src/lib.js:64`). Paused ticks skip classify, log `inflow:paused`, and still brief.
8. Verdict loop `:469-537`: first-wins validation, strict action enum, numeric-or-null id. `new` INSERTs (`:496-508`) with an `UNREVIEWED` note (`:507`) and capped `effectiveScore` (`worker/src/lib.js:30`, cap 6000 `:23`); overflow stays unprocessed (`:486`); slug collision links as supports (`:516-523`).
9. Verdict flush: `:538` `flushVerdictWrites` (`:291`, one batch with per-write fallback; failures as `verdict:N_failed`).
10. Briefs: main `:550-589` (top-scored live-only, or oldest-unreviewed-first past 48h) plus extra `:596-631` when the oldest unreviewed exceeds 48h, via `buildBriefPrompt` (`:202`), `parseBriefJson` (`:213`), `insertBrief` (`:224`, never stores empty); poison rotation `:248-265`; failures `brief:failed`.
11. Finish: `:634` single `finish("ok", …)` carrying mode/pause/stale/src_fail markers; errors `:636-644` finish `error` plus the `console.error("cron-failed", …)` tail marker (`:642`, also `:653`, `:717`).
12. Dashboard review: `refreshReview` (`public/app.js:277`) derives via `deriveReviewList` (`:274`, `needs_review` bit with notes fallback); `renderReview` (`:224`) shows decision + brief lines (`:205-222`) with Vet / Vet-&-starter / Kill; `renderStartHere` (`:141`) carries Vet/Kill for unreviewed top picks; the pill mirrors the backlog via `reviewBacklogBit` (`:329`) with a review-filter jump.
13. Vet — the path that moves unreviewed to vetted: `public/app.js:545` `vetOpportunity` → `:526` `fetchDetailForWrite` (token-gated detail fetch, N+1 prefetch `:529`) → `:550` inner → `:473` `vettedNotes` (clears `UNREVIEWED`, appends `[YYYY-MM-DD vetted]`) → `PATCH /api/opportunities/:id`. Starter variant `:575` adds a planned experiment and flips the row to `testing`. Kill (`:611`, drawer `:1042`) writes `[date killed]` + post-mortem. `V`/`K` keys (`:642-654`) with auto-advance: one human verdict per keypress, no bulk path.
14. API writes: `updateOpportunity` (`functions/api/[[path]].js:224`, text bounds, status/range guards, tagless-clear 400 `:258-262`, `effectiveScore` `:264`); `createExperiment` (`:352`) / `updateExperiment` (`:413`, won/lost require `result` + `post_mortem`, stamps, shared `outcomeLedgerLine` `:92`, cents clamps, `revenue_source` retry `:393-402`/`:468-477`).
15. Health: `functions/api/[[path]].js:494-673` — 12 probes (`:514-527`) in one batch (`:528`) with per-probe isolation fallback (`:537-566`, failures named in `health_probe_failures` + column-only `health_probe_detail`), lazy self-migration (`:575-591`), `last_vetted`/`last_verdict` parsed in JS (`:626-639`) from bounded tails (`:526`); payload `:672` (`ok:false` + nulls only on total outage).

Where it most often breaks or goes silent: hop 13, the human Vet press. Nothing automated was ever supposed to vet: cron ticks succeed (`hours_since_last_ok_run` 2.2) while `vetted_last_7d` stays 0, `last_vetted`/`last_verdict` stay null, and the oldest unreviewed ages (181.9h and rising). Second: the money probes return null because the money columns never reached live D1 and the self-migration is disabled (F3).

## 3. Health signals measured here

- Test suite: `npm test` (`node --test` over the 7 files in `package.json:8`, node `v22.22.3`) → exit 0 this session, every visible TAP suite `ok` (visible window covers 40KB/42+ suites; full tail truncated by output bounds, exit code observed). Totals pinned by the same-HEAD Windows baseline `_night/tests-baseline.log:287-294`: 414 tests / 133 suites, 414 pass, 0 fail, 0 skipped, `duration_ms 90258.9568`. Positive control against a zero-test pass: dozens of observed `ok N - …` lines plus exit 0 (a 0-test run prints no suites).
- Parse: `node --check public/app.js` → exit 0 (only the sandbox `UNDICI-EHPA` proxy warning on stderr). No Python sources exist (glob `**/*.py` matches nothing; control: the same glob tool on `**/*` lists the shipped JS files), so `compileall` has no inputs; JS parse is pinned by the shipped-JS parse-gate suite (with a broken-syntax positive control) inside the green run.
- Dead code: none in shipped source. Regex `console\.|debugger` over `functions`, `worker/src/index.js`, `worker/src/lib.js`, `public/app.js` hits only the three deliberate `console.error("cron-failed", …)` markers (`worker/src/index.js:642,653,717`) plus one comment mentioning `console.*` (`:640`); no `debugger`. Control: the same regex matches 6 harness lines in `worker/src/index.test.js:626-631,796-806`, so the three is real.
- Duplicated logic: none material. `effectiveScore` once (`worker/src/lib.js:30`), imported by the API (`functions/api/[[path]].js:10`); `tokensMatch` shared (3 worker checks + API `authed`); brief/classify/insert share `buildBriefPrompt` (`:202`), `parseBriefJson` (`:213`), `buildClassifyPrompt` (`:272`), `insertBrief` (`:224`); verdict writes share `flushVerdictWrites` (`:291`); both close paths share `outcomeLedgerLine` (`functions/api/[[path]].js:92`).
- TODO density: zero in shipped source. Regex `TODO|FIXME|XXX|HACK` over `public/app.js`, `functions/api`, `worker/src`, `d1`, `deploy`, `scripts` matches nothing. Control: the same tool+mode matches `UNREVIEWED` 17 times in `public/app.js` alone, so the zero is real.
- Surface rules: light-only (`public/styles.css:4` `color-scheme: light`; `prefers-color-scheme|data-theme|color-scheme` over `public/` hits only `styles.css:4` plus the negative assertions in `tab-icon.test.mjs`/`dashboard.test.mjs`, zero shipped dark branches). Favicon linked (`public/index.html:9-10`); `public/favicon.svg` is 284 bytes (`wc -c`), 32×32 `$` on `#0d6b3f`; brand mark inline in the header (`public/index.html:16`, same geometry/accent/glyph); guard suites green inside the exit-0 run. Live dashboard HTML is byte-identical to the repo (`cmp _night/live/aimoney_pages_dev.html public/index.html`, exit 0, no output).
- Tree: `git status --short` empty before this file; HEAD `d4262cd` (`Night round 3 … review prefetch, stale-run badge, verdict probe bound`), parent `af7f6d4` = live rev; `.gitattributes:4` pins `eol=lf`.
- Live snapshot read from `_night/live/aimoney_pages_dev_api_health.html:1`: `ok:true, db:up, opportunities:27, unreviewed:11, bare_without_brief:19, experiments_by_status:{planned:2}, hours_since_last_ok_run:2.2, oldest_unreviewed_age_h:181.9, decisions_last_7d:0, revenue_last_7d:null, revenue_total:null, spent_total:null, vetted_last_7d:0, last_vetted:null, last_verdict:null, vetted_no_experiment:0, noise_24h:0, health_probe_failures:[revenue_week,revenue_lifetime], health_probe_detail:{revenue_week:revenue_cents, revenue_lifetime:revenue_cents}, schema_missing_columns:[revenue_cents,spent_cents], schema_migration:disabled…`. Prior snapshot (docs round-4 audit): same 11 unreviewed at 178.7h — the queue has not moved between snapshots; the age rises ~1d/d.

## 4. Ranked findings (max 8)

Lane metric (aimoney): experiments reaching a decision (won/lost + post-mortem) per week, and vetted proposals becoming experiments; unreviewed backlog drained. Live now: `decisions_last_7d` 0, `vetted_last_7d` 0, `vetted_no_experiment` 0, unreviewed 11 (oldest 181.9h / 7.6d, rising ~1d/d), bare-without-brief 19/27, experiments `{planned: 2}`, `last_vetted`/`last_verdict` null, `hours_since_last_ok_run` 2.2. Was: same 11 unreviewed at 178.7h — six rounds shipped and the queue has not moved once.

Money-first (owner directive), in this project's own numbers. This project is a tool the owner uses to rank and test AI-money ideas, not a product he sells — rank by owner time saved and decisions/week, measured the same way. Earned to date: none measured — `revenue_total`, `revenue_last_7d`, `spent_total` all null (unknown, not zero; the live D1 lacks the money columns so the probes cannot run). Last krone arrived: never recorded. Single step between now and the next payment: vet the 11 rows, Start one $0-capital starter, run it to won/lost with a human-entered $ amount + post-mortem. Measured conversion at that step: 0/11 vetted (0%), 0/2 planned started (0%), 0 decisions/week. Honesty: no projection as result, no rate × volume, no attempt counted as outcome (signals seen ≠ proposals, proposals ≠ vetted, planned ≠ running). The single owner action that moves it, in one line: open Needs-review oldest-first and press V or K on each of the 11 rows.

### F1. Eleven unreviewed, oldest 7.6 days — a human press is the only path, and it has not happened

Evidence. The path, in one sentence: a manual dashboard button — `public/app.js:545` `vetOpportunity` → shared `vettedNotes` (`:473`: `` `${cleanUnreviewed(notes)}\n[${day} vetted] Human vetted; cap lifted.` ``) → `PATCH /api/opportunities/:id` (`functions/api/[[path]].js:224`). The worker never vets by design: `worker/src/index.js:4-5` (`The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed)`), `README.md:72` (`researching → testing is a human decision … The agent never moves status`). The worker creates the marker (`worker/src/index.js:507`: `` `… — UNREVIEWED, scores capped until a human vets it …` ``) and every other `UNREVIEWED` site in `index.js` is a create/count/select site — zero clearing paths. So `vetted_last_7d` 0 with `hours_since_last_ok_run` 2.2 is design, not failure: no guard misfires, no budget exhausts, no query returns wrong candidates, no exception is swallowed — cron triage + briefs run and verdicts stay human-gated. What a single run of the path produces is certified by the real-path test `Vet PATCH clears UNREVIEWED and health counts +1 vetted with last_vetted today` (`functions/api/api.test.mjs:2003`, green): one Vet press yields unreviewed −1, `vetted_last_7d` +1, `last_vetted` = today. Health already dates the stall: `last_vetted` + `last_verdict` (`functions/api/[[path]].js:626-639`, payload `:672`; live shows both null).

Why it costs: the lane metric is frozen at every stage (0 vetted/week → 0 started → 0 decisions/week, 2 planned stuck), inflow is paused at 0/tick while unreviewed > 10 (`worker/src/index.js:430-433`, classify skipped `:444-457`, `inflow:paused` on the finish line `:634`), and 19/27 rows lack the brief that makes a sub-minute vet possible.

Fix: no code change — the 2-minute path (`V`/`K` + auto-advance, `public/app.js:642-654`, one verdict per keypress, token-gated; N+1 prefetch `:512-529`, so each verdict costs one round trip; inline decision + brief lines `:205-222`, no drawer round-trip) already shipped with the suite green. The owner opens the Needs-review filter oldest-first and records Vet (or Vet-&-starter) vs Kill per row. Touch no repo files. Size S (minutes). Risk none (reversible token-gated PATCHes, human presses every verdict, no status auto-moves; every Kill carries its required post-mortem).

### F2. Live serves the previous commit — prefetch, stale badge, and probe bound are shipped but not serving

Evidence. Live `/api/health` `rev` is `af7f6d43fece4ad29953a3e42f770d553f20df26`; HEAD is `d4262cd` (`Night round 3 … review prefetch, stale-run badge, verdict probe bound`, parent `af7f6d4`). HEAD adds the review-detail prefetch (`public/app.js:486-529`), the stale-`running` badge, and the verdict-probe `LIMIT 2000` (`functions/api/[[path]].js:526`); live predates all three. `cmp` on the dashboard shell is byte-identical (exit 0) — the drift is in `app.js`/API, not `index.html`, exactly matching round 3's file list.

Why it costs: the owner clears 11 rows at two round trips per verdict instead of one; stuck `running` rows show no badge live; thousand-verdict histories scan unbounded on the live probe.

Fix: deploy HEAD — Pages auto-deploys on push to `master` (`scripts/stamp-release.sh` stamps the full SHA + release), then run `deploy/verify.sh` and require PASSED: the live-revision gate (`deploy/verify.sh:66-106`) plus agent-freshness (`:116-124`) fail closed. The worker leg needs the two repo secrets (§5); without them ship Pages-only and say so. Touch no repo files. Size S. Risk low (414 green + the verify gate).

### F3. Money legs null — the columns never reached live D1 and the migration is disabled

Evidence. Live: `revenue_last_7d/revenue_total/spent_total` null with `health_probe_failures:[revenue_week,revenue_lifetime]`, `health_probe_detail:{…:revenue_cents}`, `schema_missing_columns:[revenue_cents,spent_cents]`, `schema_migration:disabled…`. The two failing probes are the only ones reading money (`functions/api/[[path]].js:521-522`, `SUM(revenue_cents)` / `SUM(revenue_cents/spent_cents)`). `d1/schema.sql` is all `CREATE TABLE IF NOT EXISTS` (no-op on the existing table); the ADD COLUMNs live in `d1/migrate-2026-09-20-experiment-cents.sql:5-6` (+ `revenue_source` in `d1/migrate-2026-09-20-revenue-source.sql:5`), applied after `schema.sql` by both CI (`.github/workflows/deploy-worker.yml:27` then `:33-37` `Apply D1 migrations in sorted order` via `./deploy/apply-d1-migrations.sh`) and `deploy/deploy.sh:36` then `:40` — one shared loop + tolerate-list (`deploy/apply-d1-migrations.sh:13-28`, duplicate-column no-op, anything else exits 1), pinned by the convergence tests (incl. the withhold-one-file positive control). The in-worker fallback is deliberately off: `functions/api/[[path]].js:53` (`if (String(env.ALLOW_SCHEMA_MIGRATION || "") !== "1")` → report missing + disabled, change nothing). Migration-ask results, all green in this session's exit-0 run: old schema + `ALLOW_SCHEMA_MIGRATION=1` ends with every probed money column and reports numbers on the same call; var unset leaves the table unchanged and names the missing columns; second run is a clean no-op (`self-migration switch` suite). Exact variable name: `ALLOW_SCHEMA_MIGRATION`.

Why it costs: earned-to-date is unknown rather than zero, so the money-first question cannot be answered from the project's own data. (The decisions COUNT split, `:520`, already saved `decisions_last_7d` = 0 — the money legs are the only remaining nulls.)

Fix: no code change; the path is already correct. The owner sets `ALLOW_SCHEMA_MIGRATION=1` as a Pages env var — the next `/api/health` PRAGMAs `experiments`, applies exactly the two ADD COLUMNs one at a time, and re-runs the failed money probes on the same call — or adds the two Cloudflare repo secrets and redeploys so CI applies the migrations. One variable, one decision; see §5 for the exact lines. Touch no repo files. Size S. Risk none (ADD COLUMN with DEFAULT cannot lose a row; unset behaviour is byte-identical to today).

### F4. Vet-&-starter retry can duplicate the starter experiment

Evidence. `vetAndLogStarterInner` (`public/app.js:580-609`) runs three sequential writes — Vet PATCH (`:588-591`), experiment POST (`:592-599`), status PATCH (`:600-603`) — and the catch (`:608`) only toasts `Starter failed: …` with no resume or dedupe. `createExperiment` enforces no name uniqueness (`functions/api/[[path]].js:352-411`), so a transient failure on step 3 followed by a retry POSTs a second identical planned starter. (Retry-duplicated `[date vetted]` tags are harmless: the vetted probe counts rows, `:523`.) Companion gap: a row left `testing` with only a planned starter shows no badge — `testingBadge` (`:1373`) covers testing-with-zero-experiments only, `runningMismatchBadge` (`:1385`) covers running-with-researching-parent only.

Why it costs: lane-metric clutter at the vetted→experiment hop (planned count inflates; the stale-first board and the stalest-nudge point at dupes), and a failed tap teaches the owner the button is unsafe on the exact hop the money path needs.

Fix: before the POST, skip when a planned experiment named `Starter: <title>` already exists for the row (from state or one GET), so a retry resumes instead of duplicating; add a read-only testing-with-nothing-running badge beside `:1373`. Pin in `public/dashboard.test.mjs`: fail the status PATCH, retry, assert exactly one starter. Touch `public/app.js`, `public/dashboard.test.mjs`. Size S. Risk low (read-only pre-check; no auto status moves).

### F5. Verdict-tag guard and health max-parse accept impossible dates

Evidence. `VERDICT_TAG` (`functions/api/[[path]].js:84`) is `/\[\d{4}-\d{2}-\d{2} (vetted|killed)\]/` — shape only, no calendar check — and the health max-parse uses the same loose shape (`:631`, `:635`, string-max). The malformed-date test (`functions/api/api.test.mjs:2079`) covers only wrong-shape tags (`[2026-9-5 vetted]`, `[09/20/2026 killed]`, `[vetted]`). A digit-shaped-but-impossible tag such as `[2026-13-99 vetted]` passes the guard and then wins the string-max, poisoning `last_vetted`/`last_verdict` (`vetted_last_7d` is immune: exact-day OR, `:523`). The dashboard never emits this shape (`toISOString` slice, `public/app.js:474`) — raw-API-only today, the same class as the just-fixed tagless clear.

Why it costs: the stall-age honesty F1 relies on (`last_vetted`/`last_verdict` null-or-truthful) is corruptible by one typo'd PATCH.

Fix: constrain month/day ranges in the guard and both parse regexes (or `Date.parse`-validate the capture); pin `…13-40…` 400sing the PATCH with the row untouched and never surfacing in `last_verdict`. Touch `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Size S. Risk low (no dashboard path emits non-calendar dates).

### F6. openDrawer bricks on one malformed skills_needed row

Evidence. `public/app.js:1017` runs `JSON.parse(o.skills_needed || "[]")` with no guard inside `openDrawer` (`:1001`), while the adjacent brief parses (`:988-990`) and the cache parse (`:1462`) are all try/caught. A throw lands in `:1047` (`toast("Could not open: …")`) and the drawer never opens. API writers always stringify (`functions/api/[[path]].js:204`, `:263`), so the trigger is hand/legacy data only; review-row Vet/Kill buttons are unaffected (notes-only path, `public/app.js:526-543`).

Why it costs: one bad row loses its drawer — facts, brief, experiments, drawer Vet/Kill — until the data is fixed; the verdict stays possible via row buttons, so P1 not P0.

Fix: parse-or-empty mirroring `:988` (`let skills = []; try { … } catch {}`), rendering `—` on malformed. Pin in `public/dashboard.test.mjs`: malformed skills renders `—` and the drawer opens with no toast. Touch `public/app.js`, `public/dashboard.test.mjs`. Size S. Risk low (render-only; writers untouched).

## 5. What NOT to change

- The agent never vets, by documented design. `worker/src/index.js:4-5`: `The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed).` `README.md:72`: `researching → testing is a human decision … The agent never moves status.` Do not add auto-vet, auto-kill, or auto-testing without an owner-written rule, reversibility, and a real-path test.
- The self-migration stays default-off, ADD-only, triggerless. `functions/api/[[path]].js:16-25` (switch docblock), `:53` (unset → report + change nothing), `:59-67` (one ADD at a time, duplicate-column tolerated, anything else stays missing), once per isolate (`:35,:69-71`). Do not default it on, do not add a second trigger, and do not add a migration endpoint: `a URL that alters the schema is a liability even when it is authenticated.`
- Never a data-losing migration here: ADD only — `No DROP, no ALTER of an existing column, no data rewrite, no DELETE.`
- Cloudflare repo secrets are the owner's. The workflow fails fast with a named message until they exist (`.github/workflows/deploy-worker.yml:20-26`). His one line: Settings → Secrets → Actions → add `CF_API_TOKEN` and `CF_ACCOUNT_ID`, then redeploy.
- `ALLOW_SCHEMA_MIGRATION=1` is the owner's decision (a live-DB change); unset behaviour is byte-identical to today. His one line: Pages Settings → Environment variables → add `ALLOW_SCHEMA_MIGRATION=1` to production, retry the deployment, reload `/api/health` once — the two money columns appear and the money legs fill on the same call.
- Clearing the 11 rows is the owner's (needs `ADMIN_TOKEN` + human judgment per row; an offline implementer has neither). His one line: open Priority → Needs review oldest-first → press V or K on each of the 11 rows (~2 min); `unreviewed` → 0 reopens inflow.
- Starting an experiment to a decision is the owner's. His one line: `Zero spend` chip → `Vet & log starter` → Experiments `Start` → run the smallest real test within a week → `Win` (human-entered $ + optional spend + `via {source}`) or `Lose`, both with result + post-mortem.
- Deploying HEAD is the owner's (needs network + push). His one line: push `d4262cd` to `master` (or let the pending branch merge), then `./deploy/verify.sh` must print PASSED.
- No writes to production D1 from any round: no `wrangler d1 execute … --remote`, no manual migration, no seed. Applying migrations live is the owner's action.
- Verdicts need a login, a credential, and a human: `ADMIN_TOKEN` (Pages env + worker secret + dashboard `localStorage`) plus per-row judgment. Never mark an experiment won/lost without `result` + `post_mortem` evidence, and never invent a revenue figure.
- Never, whatever the ranking says: no spending, no account or identity creation, no outward sends, no accepting terms, no captcha solving, no fabricated reviews/receipts/testimonials, no scraping or messaging a platform's terms forbid, no financial advice or implied return.
- House rules honored by this audit: never read `.env`/secrets/tokens; no edits to existing files (this findings file only); CRLF care unneeded (nothing edited; `.gitattributes:4` pins `eol=lf`).

## 6. Proposed next tasks (2–4)

Focus compliance: the brief's vet ROUND resolves to its no-automation branch — nothing was ever supposed to vet (F1), and the smallest thing for eleven rows in minutes (V/K + auto-advance + prefetch) already shipped green. Task 1 is the remaining unsafe edge on that exact 11-verdict path, worded standalone. Live vetting, deploying, secrets, and the migration switch need network/credentials/human judgment, so they are owner actions in §5, not tasks.

### Task 1. Make Vet-&-starter retry-safe: no duplicate starter on a failed tap

Owns: `public/app.js`, `public/dashboard.test.mjs`. Context (F4): `vetAndLogStarterInner` (`public/app.js:580-609`) runs Vet PATCH → experiment POST → status PATCH with no resume; a transient failure on step 3 plus a retry POSTs a second identical planned starter (`createExperiment` enforces no name uniqueness). Before the POST, skip when a planned experiment named `Starter: <title>` already exists for the row (from state or one GET); add a read-only testing-with-nothing-running badge beside `testingBadge` (`:1373`).

Acceptance: a test that fails the status PATCH, retries, and asserts exactly one planned starter exists and the row still reaches `testing`; the new badge renders for testing-with-only-planned and nowhere else; full `npm test` green.

### Task 2. Reject impossible verdict-tag dates in the guard and health max-parse

Owns: `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Context (F5): `VERDICT_TAG` (`:84`) and the health max-parse (`:631`, `:635`) validate `\d{4}-\d{2}-\d{2}` shape only, so `[2026-13-99 vetted]` passes the guard and poisons `last_vetted`/`last_verdict` via string-max. Constrain month/day ranges in all three regexes (or `Date.parse`-validate the capture).

Acceptance: a PATCH clearing `UNREVIEWED` with `[2026-13-40 vetted]` 400s naming the tag and leaves the row queued; a stored impossible tag never surfaces in `last_vetted`/`last_verdict`; `vetted_last_7d` and the existing malformed-shape cases unchanged; full `npm test` green.

### Task 3. Guard openDrawer skills parse like the adjacent brief JSON parses

Owns: `public/app.js`, `public/dashboard.test.mjs`. Context (F6): `public/app.js:1017` runs an unguarded `JSON.parse` on `skills_needed` inside `openDrawer`, while the brief parses (`:988-990`) are try/caught — one malformed row bricks its own drawer (`Could not open`, `:1047`). Parse-or-empty mirroring `:988`, rendering `—` on malformed.

Acceptance: a drawer render with malformed `skills_needed` opens normally with `—` in the Skills row and no toast; valid skills render unchanged; full `npm test` green.
