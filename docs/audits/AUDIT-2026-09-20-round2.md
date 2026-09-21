# AUDIT-2026-09-20-round2 — aimoney (read-only)

Measured 2026-09-21 ~15:30 UTC on a clean clone of the deploy branch (`git status --short` clean before writing; no AGENTS.md/CLAUDE.md in repo — README.md is the governing doc). Live snapshot: `_night/live/aimoney_pages_dev_api_health.html` (2026-09-21T13:25:18Z, rev e451b24) and `_night/live/aimoney_pages_dev.html` (byte-identical to `public/index.html` per `cmp`, exit 0). Prior rounds tonight already shipped every code item the focus names (isolation, self-migration, deploy convergence, last-verdict dates, vet-path pins); this audit verifies that state and ranks what remains, which is almost entirely owner action.

## 1. What this project is and how it runs

1. AIMoney Lab: ranked AI-money opportunities with research briefs, experiments, and a cron research agent; lane metric is experiments reaching a decision (won/lost + post-mortem) per week and vetted proposals becoming experiments, with the unreviewed backlog drained.
2. Entry points: static dashboard `public/` (`app.js`), Pages Functions API `functions/api/[[path]].js` on D1, research worker `worker/src/index.js` (cron + manual `POST /run`).
3. Live surfaces: `https://aimoney.pages.dev`, `/api/health` (`ok:true`, `db:up`, 27 opps / 11 unreviewed / 19 bare / `{planned: 2}` / 0 decisions / 0 vetted / revenue nulls with named probe failures), worker `GET /` (`research-v1`).
4. Scheduled jobs: worker cron `0 */6 * * *` (`worker/wrangler.toml:9`); GitHub workflow `.github/workflows/deploy-worker.yml` on push to master (schema + shared migrations + worker deploy).
5. Deploy: `./deploy/deploy.sh` (D1 schema, shared `apply-d1-migrations.sh`, guarded seed, stamp `release.json`, Pages deploy, worker deploy), then `./deploy/verify.sh` (markers, app.js parse, live-revision, non-empty list, agent freshness); Pages also auto-deploys from Git via `scripts/stamp-release.sh`.

## 2. End-to-end walk-through

Signal → proposal → vet → experiment → decision → money, with file:line per hop:

1. Cron fires `scheduled` (`worker/src/index.js:648-656`) → `runResearch(env, "cron")` (`:308`); stuck `running` rows reaped (`:312-317`), run row opened (`:318-327`).
2. Collect: HN/Reddit/GitHub in parallel (`:343`), each fetch body-covered by `timedJson` (`:37-47`); a fully failed source is named in `src_fail` (`:74`, `:102`, `:131`, `:345-349`).
3. Signals batch-inserted in one round-trip (`:354-359`); >30d unprocessed swept to noise with a count (`:367-372`); oldest 6 taken (`:374-376`).
4. Exact-URL pre-pass (`:386-413`): bounded `IN` selects (`:394-400`) + pure `exactUrlTarget` (`worker/src/lib.js:168-178`) link repeats as supports (notes newest-kept, no status move); failed links counted, never thrown (`:407`).
5. Inflow gates read once (`:425-433`): bare-without-brief > 10 caps inserts to 1; **unreviewed > 10 caps to 0 — live state (11), so every current tick inserts 0 and skips the classify call entirely (`:444-457`, logged `inflow:paused`)**.
6. Classify (only when cap > 0): top-60 list + `buildClassifyPrompt` (`:272-284`, LF-joined), Mistral via `aiComplete` (`:136-153`, budget `MAX_AI_CALLS=4` `:19`), NDJSON `parseJsonLines` (`worker/src/lib.js:64-79`).
7. Verdict loop (`:469-537`): first-wins, strict enum, numeric-or-null id; `new` INSERTs (`:496-507`) with `UNREVIEWED` note and capped `effectiveScore` (`worker/src/lib.js:30-33`, cap 6000 `:23`); slug collision links as supports (`:512-524`); writes flushed by `flushVerdictWrites` (`:291`, batch + per-write fallback, `verdict:N_failed`).
8. Brief pass, cron only (`:540-631`): one bare row (oldest-unreviewed-first past 48h `:550-568`, else top-scored excluding killed/paused `:566-568`) + one extra oldest-unreviewed past 48h (`:596-631`); shared `buildBriefPrompt` (`:202`), `parseBriefJson` (`:213`), `insertBrief` (`:224`, never stores an empty brief); poison rows rotated via `selectBareRow` (`:257-265`).
9. Single `finish("ok", …)` carrying mode/pause/stale/fail markers (`:634`); errors finish `error` plus the deliberate `console.error("cron-failed", …)` tail marker (`:642`, also `:654`, `:718`).
10. Dashboard lists `GET /api/opportunities` (`functions/api/[[path]].js:130-172`: `needs_review` bit `:149`, full notes stripped, scores re-capped `:162-167`, client re-sort `:168-170`); review chip derives the oldest-first queue client-side (`public/app.js:277-291`); `V` vets / `K` kills with auto-advance (`:638-653`).
11. **Vet — the ONLY path from unreviewed to vetted** — `vetOpportunity` (`public/app.js:496`) → token-gated `fetchDetailForWrite` (`:486`) → inner (`:501`) → shared `vettedNotes` (`:476-479`, clears `UNREVIEWED`, appends `[YYYY-MM-DD vetted]`) → `PATCH /api/opportunities/:id` → `updateOpportunity` (`functions/api/[[path]].js:224`, tagless-clear 400 `:258-261`, rescore `:264`). Starter variant (`:526-559`) adds a planned experiment + flips to `testing`; Kill (`:562-591`, drawer copy) writes `[date killed]` + post-mortem.
12. Experiments: `createExperiment` (`:352`) / `updateExperiment` (`:413`): won/lost require `result` + `post_mortem`, `started_at`/`ended_at` stamps, shared `outcomeLedgerLine` (`:92-97`) ledger append, cents clamps, `revenue_source` retry on old tables (`:393-402`, `:468-477`); board carries `days_in_status` + `orphaned` (`:315-350`).
13. Health `GET /api/health` (`:494-669`): 12 named probes (`:510-527`) in one batch (`:528`), per-probe fallback naming failures + missing column only (`:537-566`), lazy self-migration re-running failed money probes (`:575-591`), `last_vetted`/`last_verdict` parsed in JS from 500-char tails (`:622-636`), key-ordered payload (`:669`) with null-on-failure (never 0).
14. Deploy convergence: CI runs `schema.sql` (`:27`) then the shared `deploy/apply-d1-migrations.sh` (`:34`), same script `deploy.sh` calls (`deploy/deploy.sh:40`); the script loops the sorted `d1/migrate-*.sql` glob tolerating only duplicate-column (`apply-d1-migrations.sh:13-27`).

Where it most often breaks or goes silent: hop 11, the human Vet press — nothing automated was ever supposed to vet (worker: `worker/src/index.js:4-5`, README.md:72), so cron succeeds (`hours_since_last_ok_run` 1.4) while `vetted_last_7d` stays 0 and the oldest unreviewed ages (181.1h, +24h/day). Second: the money probes (hop 13) report null because `revenue_cents`/`spent_cents` never reached live D1 and the self-migration switch is unset — disclosed in-payload, not silent (see F2).

## 3. Health signals measured here

- `npm test` → exit 0: **401 tests, 130 suites, 401 pass, 0 fail, 0 skipped** (`duration_ms 90599.4`). Denominator asserted (130 suites > 0), so this is not an empty pass. Runner baseline `_night/tests-baseline.log` was also exit 0 pre-change.
- No Python sources in the repo (only inline `python3 -c` JSON readers in shell), so `compileall` is N/A; the JS equivalent is green: `node --check public/app.js` exit 0, `node --check worker/src/index.js` exit 0 (both also parsed by the suite; `functions/api/[[path]].js` is imported by `api.test.mjs`).
- Line endings: `file` over README/app/index/styles/worker-lib+index/schema/deploy.sh/stamp reports no CRLF anywhere; `.gitattributes:4` pins `* text=auto eol=lf`. The CRLF hazard in the brief does not currently bite.
- Dead code: none material. Regex `console\.|debugger` over shipped JS hits only the three deliberate `cron-failed` markers (`worker/src/index.js:642,654,718`); `debugger` zero. Control: the same regex matches the test-harness captures in `worker/src/index.test.js:626-631,796-806`, so the three is real.
- Duplicated logic: none live. Shared: `effectiveScore`/`tokensMatch` (`worker/src/lib.js:30,39`, API import `functions/api/[[path]].js:10`), `vettedNotes`, `fetchDetailForWrite`, brief/classify/insert builders, `flushVerdictWrites`, `outcomeLedgerLine`, one migration script. The last two known cases are fixed in-tree (`deriveReviewList` reuses `isNeedsReview`, `public/app.js:272-278`; `cleanUnreviewed` is one replace, `:469-471`; `lib.js:13` pointer corrected). One micro-cruft left: see F5.
- TODO density: regex `TODO|FIXME|XXX|HACK|KLUDGE` over the repo hits only 5 prose lines in `docs/audits/*.md`, zero in shipped source. Control: same tool+mode matches `UNREVIEWED` dozens of times across `worker/src` + `public/app.js`, so the zero is real. (An earlier literal-mode attempt with `|` was discarded as meaningless — literal mode can only match the pipe string itself.)
- Surface rules: PASS, no findings. Light-only (`public/styles.css:4` `color-scheme: light`; regex `prefers-color-scheme|data-theme|theme-toggle|dark-mode|setTheme` over the repo hits only the negative assertions in `tab-icon.test.mjs`/`dashboard.test.mjs` plus prior-audit prose — zero shipped hits; control: `color-scheme` matches `styles.css:4`). Favicon linked + theme-color (`public/index.html:9-10`); `public/favicon.svg` is 284 bytes (`wc -c`), 32×32 `$` on `#0d6b3f`, no external fonts; same mark inline in the header (`public/index.html:16`); guard suite `tab-icon` green inside the 401. First five seconds on a phone: masthead + agent pill + Start-here strip (`public/app.js:141-171`, rendered first at `:175`) with Needs-review count+age chip (`public/index.html:52`) — the queue age reads without scrolling; mobile CSS compacts the masthead (`styles.css:213-218`).

## 4. Ranked findings (max 8)

Money first (owner directive), from this project's own data: earned to date **none measured** — `revenue_total` is null, which honestly means unknown (probe failed), not $0. Last krone arrived: **never recorded** (`last_verdict` null, `decisions_last_7d` 0, experiments `{planned: 2}`, nothing ever `running`/`won`/`lost`). Single step to the next payment: vet one $0-capital row, log its starter, press Start, run the smallest paid test, close it `won` with a human-entered $ amount. Measured conversion at that step: **none exists to measure** — zero trials have started, so there is no rate (not 0%, undefined). This lane is a tool the owner uses, not a product he sells; it earns only through experiments it drives to a decision.

### F1. Eleven rows wait on the human Vet press; everything else already runs

Evidence. The path, in one sentence: a human presses Vet (dashboard button or `V` key), which PATCHes the row's notes to clear `UNREVIEWED` and append `[date vetted]` — `public/app.js:496` via `vettedNotes` (`:476-479`) → `PATCH /api/opportunities/:id`. The worker creates the marker (`worker/src/index.js:507`) and every other worker `UNREVIEWED` hit is create/count/select — no worker path clears it; `worker/src/index.js:4-5`: "The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed)." `README.md:71-72`: "A human admin vets each row" … "The agent never moves status." Live: `vetted_last_7d` 0, `last_vetted`/`last_verdict` null, unreviewed 11, oldest 181.1h, while `hours_since_last_ok_run` is 1.4 — the machine runs; no verdict was pressed. There is no failing test because there is no broken automation: the real-path test `Vet PATCH clears UNREVIEWED and health counts +1 vetted with last_vetted today` (`functions/api/api.test.mjs:1999`, green in the 401, driving shipped `vettedNotes` + PATCH + health against a stubbed D1) certifies what a single run produces: unreviewed −1, `vetted_last_7d` +1, `last_vetted`/`last_verdict` = today. A single cron run at the current backlog produces 0 inserts, 0 verdicts (`inflow:paused`, `worker/src/index.js:425-433` + classify skip `:438-457`), plus 1–2 briefs.

Why it costs money: the lane metric (vetted→experiments, decisions/week) has been frozen for 7+ days while the queue ages a day per day; inflow is correctly paused, so the top of the funnel is intentionally shut until a human acts.

Fix: owner action, not code — open Needs review (oldest-first, decision + brief lines inline at `public/app.js:235-236`, no drawer round-trip) and press `V` / `Vet & log starter` / `K` through 11 rows, about a minute each from a phone; the queue-clearing aid (inline buttons, `V`/`K` + auto-advance, start-here Vet/Kill, tagless-clear 400 guard) already shipped. Size S (owner minutes). Risk none.

### F2. Four money fields are null behind one unset switch the payload already names

Evidence. Live: `health_probe_failures: ["revenue_week","revenue_lifetime"]`, `health_probe_detail` names `revenue_cents`, `schema_missing_columns: ["revenue_cents","spent_cents"]`, `schema_migration: "disabled (set ALLOW_SCHEMA_MIGRATION=1 to add missing columns)"`, and `revenue_last_7d`/`revenue_total`/`spent_total` null. The switch is exactly `ALLOW_SCHEMA_MIGRATION` (`functions/api/[[path]].js:53`, `ensureMoneyColumns` `:34-72`: PRAGMA-gated to probe-read columns only, ADD-only, once per isolate, no endpoint). The three shipped-test results (suite `self-migration switch`, 6/6 green): var set → columns added and numbers reported on the same call; var unset → table unchanged, payload names columns + disabled line; second run → clean no-op (no re-PRAGMA, no re-ALTER). Deploy convergence also shipped: CI step `Apply D1 migrations in sorted order` (`.github/workflows/deploy-worker.yml:33-37`, `run: ./deploy/apply-d1-migrations.sh` at :34), same script from `deploy/deploy.sh:40`, duplicate-column-only tolerance (`apply-d1-migrations.sh:19-26`).

Why it costs money: while null, every revenue/spend figure on the dashboard is unknown rather than $0 — earned-to-date cannot be read, and a future first krone would not display.

Fix: owner sets one Pages env var `ALLOW_SCHEMA_MIGRATION=1`; the next health call adds exactly the two `ADD COLUMN` statements and reports numbers immediately. No code change. Size S. Risk low (ADD with DEFAULT cannot lose rows; default-off keeps unset behavior byte-identical).

### F3. No experiment has ever started — the $0 starter path is built but untried

Evidence. `experiments_by_status: {"planned": 2}`, `decisions_last_7d` 0 (its COUNT-only probe `functions/api/[[path]].js:520` reports honestly through the money outage), no `running`/`won`/`lost` ever. The zero-spend funnel exists end to end: `Zero spend` chip (`public/app.js:125-126,657-662`), `Vet & log starter` (`:526-559`, prefilled name/hypothesis/metric, flips to `testing`), one-click Start on planned cards, inline Win/Lose close rows (`:392-467`, human-entered $ + optional spend/source). Conversion at the start step is unmeasured because attempts are zero.

Why it costs money: experiments-decided-per-week is the lane metric and it reads 0; every other number on this board is input to this one.

Fix: human action drafted here, decided by him — filter `Zero spend`, Vet-&-starter the cheapest row, press Start, run the smallest paid test inside a week, close with a real $ figure and post-mortem. Concretely: the board's $0-capital rows (e.g. seeds like `ai-freelance-outcomes`, capital `$0`) are the candidates; pick one, do not invent revenue. No code change. Size S. Risk none at $0 spend (never spend, never claim a customer/result that does not exist).

### F4. 19 of 27 rows have no brief, so each vet decision is evidence-thin

Evidence. `bare_without_brief` 19; the review UI compensates (`no brief` pill `public/app.js:1320-1323`, `reviewBriefLine` "No brief yet" `:219-225`, chip tooltip counts bare rows `:319-325`), and brief capacity is 1–2 per cron tick with oldest-unreviewed-first past 48h (`worker/src/index.js:550-631`) — at 19 bare that drains in roughly 10–19 ticks (2.5–5 days) with no action.

Why it costs trust, not money directly: scores on bare rows are unproven, and vetting eleven rows without evidence risks fast-but-wrong verdicts.

Fix: none — let cron drain it; do not add code (no extra AI budget, no new pass). If the owner vets before the drain finishes, vet from the decision line (capital/next/source) and mark low-confidence rows for re-review. Size —. Risk none.

### F5. `reviewBriefLine` carries a dead block scope

Evidence. `public/app.js:219-225`: the function body is a bare `{ const s = …; return …; };` block — valid JS, but the inner braces and trailing semicolon scope nothing (single statement, no shadowing) and invite misreading as a closure.

Why it costs: nothing at runtime; it costs the next reader a minute and fails the "leave it tidier than the queue" bar this repo otherwise meets.

Fix: drop the inner braces so the `const` + `return` sit directly in the function body; output must be byte-identical (existing brief-line suite in `public/dashboard.test.mjs` stays green), then `npm test` green. Touch `public/app.js` only. Size S. Risk negligible (pure render helper; contract covered by tests).

## 5. What NOT to change

- The worker never vets, by design — `worker/src/index.js:4-5`: "The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed)." / `README.md:72`: "researching → testing is a human decision … The agent never moves status." No auto-vet, no timer, no bulk verdict loop.
- The migration switch stays default-off with no second trigger — `functions/api/[[path]].js:20-25`: "When columns are missing AND the owner set ALLOW_SCHEMA_MIGRATION=1 … Default-off: unset changes nothing … no endpoint". No migration endpoint, ever.
- Credentials: this repo has no `CF_API_TOKEN`/`CF_ACCOUNT_ID` and CI fails fast naming them (`.github/workflows/deploy-worker.yml:20-26`). Never create, enter, store, print, or rotate a credential. Owner action in one line: add `CF_API_TOKEN` and `CF_ACCOUNT_ID` under repository Settings → Secrets → Actions.
- Production database: no `wrangler d1 execute --remote`, no migration, no write from any round. Applying the pending ALTERs to live D1 (or flipping the switch in F2) is the owner's action.
- No outward action whatever the ranking says: no spending, accounts, applications, messages, posts, form submits, or accepted terms. Draft and queue only.
- No revenue figure without evidence: `revenue_total: null` means unknown, never $0; never multiply an unverified rate by a volume; attempts are not outcomes.
- Verdicts stay human: Vet/Kill/Start/close, post-mortems, and the suggested ±1 rescore apply are pressed by the owner; the tagless-clear 400 (`functions/api/[[path]].js:258-261`) keeps raw-API misuse from exiting the queue uncounted.
- Owner one-liners: (1) set Pages env var `ALLOW_SCHEMA_MIGRATION=1` to fill the four money fields; (2) clear Needs review with `V`/`K` (11 rows, oldest 7.5 days); (3) Start one $0 experiment this week.

## 6. Proposed next tasks (2–4)

### Task 1. Pin the real vet path end-to-end and report what one run produces

Owns: `functions/api/api.test.mjs`, `worker/src/index.test.js` (pins only; no behavior change). Context (F1): the only unreviewed→vetted path is the manual Vet button (`public/app.js:496` via `vettedNotes` `:476` → `PATCH /api/opportunities/:id`); the worker never vets by design (`worker/src/index.js:4-5`); health already dates verdicts (`last_vetted`/`last_verdict`, `functions/api/[[path]].js:622-636,669`). Drive the REAL path against a stubbed D1 — an `UNREVIEWED` row → shipped `vettedNotes` + Vet PATCH → `/api/health` — asserting unreviewed −1, `vetted_last_7d` +1, `last_vetted` = today; cover the tagged-kill PATCH dating `last_verdict`; and drive a real `runResearch` tick at unreviewed 11 asserting 0 inserts with `inflow:paused`. Where a pin already exists (e.g. `api.test.mjs:1999`), quote its name and count it green rather than duplicating it; add only the missing leg. No network, no creds, no production writes.

Acceptance: the vet-pin, kill-pin, and paused-tick cases are named in the report with pass counts; `npm test` exit 0; the report states in one line what a single Vet run and a single cron run at backlog 11 each produce.

### Task 2. Write the one-page owner drill: queue, migration switch, $0 starter

Owns: `docs/OWNER-ACTIONS.md` (new file only; no code, no workflow, no existing-file edits). Context (F1–F3): the remaining work is three owner actions blocked on him, not on code. Draft one page with the exact strings: Needs-review + `V`/`K` flow for 11 rows, `ALLOW_SCHEMA_MIGRATION=1` Pages env var, and the Zero-spend → Vet-&-starter → Start → close-won-with-$ loop — each a one-line action plus where to see the result (`/api/health`, `last_verdict`, `decisions_last_7d`). No spending, no accounts, no sends, no terms.

Acceptance: the file exists with all three actions and their exact names/keys; `npm test` still exit 0 (untouched); nothing outside the new file changed.

### Task 3. Remove the dead block scope in reviewBriefLine

Owns: `public/app.js` (`public/dashboard.test.mjs` only if a pin needs touching). Context (F5): `reviewBriefLine` (`public/app.js:219-225`) wraps its body in a purposeless inner block. Unwrap it so the excerpt `const` + `return` sit directly in the function; rendered output byte-identical ("No brief yet" fallback, 200-char trim).

Acceptance: existing brief-line/dashboard suites green; `node --check public/app.js` exit 0; `npm test` exit 0.
