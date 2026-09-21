# Audit 2026-09-20 round 3 — aimoney (read-only)

Clone root: `/root/coding-projects/_workspace/trackb-aimoney-r3` (clean; `git status --short` empty before this file). No existing file edited, no network, no installs, no secrets read. Only this file created. Line endings all LF (`git ls-files --eol`, `.gitattributes` pins `eol=lf`) — no CRLF hazard in this clone.

## 1. What this project is and how it runs

- Purpose: AIMoney Lab — ranked AI-money opportunities with research briefs and experiments; the agent proposes, a human vets and tests.
- Entry points: `public/index.html` + `public/app.js` (dashboard), `functions/api/[[path]].js` (D1-backed REST API), `worker/src/index.js` (research agent).
- Live surfaces: `https://aimoney.pages.dev/` (dashboard), `/api/health`, `/api/opportunities`, `/api/runs`, worker `https://aimoney-research.levitinvlad.workers.dev/`.
- Scheduled jobs: worker cron `0 */6 * * *` (collect + triage + briefs) and manual `POST /run` (202, triage-only, `briefs_skipped:true`).
- Deploys: Pages Git-connected (`public/` + `scripts/stamp-release.sh`) plus CI `.github/workflows/deploy-worker.yml` (schema + shared migrations + worker) or manual `deploy/deploy.sh`, gated by `deploy/verify.sh`.

## 2. End-to-end walk-through

Signal to decision; the hop where it most often goes silent is last.

1. Collect: `worker/src/index.js:49` `hnSignals`, `:78` `redditSignals`, `:106` `githubSignals` via `timedJson` (`:37`, 6s timeout covering the body read). All-queries-failed names the source in `src_fail`.
2. Store: `:354-359` one batched `INSERT OR IGNORE INTO signals`, then heartbeat `:360-363` (`phase:collected`).
3. Sweep: `:368-372` unprocessed signals older than 30d become noise (`stale:N`).
4. Take: `:374-376` oldest-first `LIMIT 6`; exact-URL pre-pass `:382-408` links URL duplicates as supports with no AI call (pure `exactUrlTarget`, `:168`).
5. Inflow gates: `:421-428` bare-without-brief > 10 caps inserts to 1/tick; unreviewed > 10 pauses inflow to 0/tick. Paused ticks skip the classify AI call entirely (`:440`, logged `inflow:paused`, still brief).
6. Classify (one AI pass, unpaused ticks): `buildClassifyPrompt` (`:272`) + `aiComplete` (`:136`, timeouts, cron retries 1), parsed by `parseJsonLines` (`worker/src/lib.js:62`, NDJSON + `repairJson`).
7. Verdict writes: `:464-532` accumulated, flushed by `flushVerdictWrites` (`:291`, batch with per-write fallback, `verdict:N_failed`). New rows `INSERT` with `UNREVIEWED` (`:502`) and capped `effectiveScore`; slug collision links as supports (`:507-519`).
8. Briefs: main `:545-584` (top-scored, or oldest-unreviewed-first past 48h) plus extra `:591-626` when oldest unreviewed exceeds 48h, via `buildBriefPrompt` (`:202`), `parseBriefJson` (`:213`), `insertBrief` (`:224`, never stores empty), poison rotation `:248-265` (`brief:skipped:N`).
9. Finish: `:629` single `finish("ok", …)` carrying `brief:mode`, `stale:`, `src_fail:`, `brief:failed`, `verdict:N_failed`; errors `:631-639` finish `error` plus `console.error("cron-failed", …)` tail marker. Stuck `running` rows reaped by the next run (`:312-317`, 30min).
10. Dashboard review: `public/app.js:242` `refreshReview` (client-side `deriveReviewList` `:239`, API fallback only at `>= 200` rows — matches the `limit=200` fetch at `:1474`, so no gap), `:189` `renderReview` with decision line (`:167` capital + next + source) and brief line (`:181` summary or `No brief yet`) plus inline Vet / Vet-&-starter / Kill (`:199-203`); `:103` `renderStartHere` with Vet/Kill for unreviewed top picks (`:124-131`); `V`/`K` keys with auto-advance (`:585-600`, inputs/dialog/drawer correctly ignored at `:589-590`); agent pill mirrors `N to review · oldest Xd` (`:294-302`, `:811-820`) and jumps to the queue (`:861-866`).
11. Vet (the ONLY path from unreviewed to vetted): `public/app.js:443` `vetOpportunity` → `:433` token-gated detail fetch → `:448` inner → `:423` `vettedNotes` (clears `UNREVIEWED`, appends `[YYYY-MM-DD vetted]`) → `PATCH /api/opportunities/:id`. Starter variant `:473` adds a planned experiment and flips the row to `testing` (`:498-501`). Kill (`:509`) writes `[YYYY-MM-DD killed]` + post-mortem (`:522`).
12. API writes: `functions/api/[[path]].js:209` `updateOpportunity` (bounds, guards, `effectiveScore`), `:326`/`:390` experiment create/update (won/lost require `result` + `post_mortem`, stamps, outcome ledger `:377-386`/`:427-436`, cents clamps, `revenue_source` retry tolerance).
13. Health: `:474-641` 12-probe batch (`:494-507`) with per-probe isolation fallback (`:517-546`, `health_probe_failures` + column-only `health_probe_detail`), lazy self-migration (`:555-571`), `last_vetted` JS parse over a 500-char tail (`:600-608`), total-outage honesty (`ok:false`, nulls).

Where it most often breaks or goes silent: hop 11, the human Vet press. Nothing automated was ever supposed to vet (F1): cron ticks succeed (`hours_since_last_ok_run` 4.5) while `vetted_last_7d` stays 0 and the oldest unreviewed ages (178.2h and rising). Second: the money probes return null because the columns never reached live D1 and the self-migration is disabled (F2).

## 3. Health signals measured here

- Test suite: `npm test` (`node --test` over `worker/src/lib.test.js`, `worker/src/index.test.js`, `functions/api/api.test.mjs`, `d1/migrations.test.mjs`, `deploy/deploy.test.mjs`, `public/tab-icon.test.mjs`, `public/dashboard.test.mjs`) → exit 0, full TAP, no narrowing, `node v22.22.3`. Dot-reporter rerun: 499 passing dots, 0 failures, exit 0. Both runs real, this session.
- Parse: `node --check public/app.js` → exit 0 (only the sandbox `UNDICI-EHPA` proxy warning on stderr). `python3 -m compileall`: not applicable — zero `*.py` files in repo (glob search, no matches; `python3` appears only as one-liners inside shell scripts).
- Dead code: none material in shipped source. `console.*` is only the three deliberate `console.error("cron-failed", …)` markers (`worker/src/index.js:637,649,713`); no `debugger`. Shared helpers already deduped (`effectiveScore`, `tokensMatch`, `buildBriefPrompt`, `parseBriefJson`, `buildClassifyPrompt`, `insertBrief`, `flushVerdictWrites`, `vettedNotes`).
- Duplicated logic: two small live ones — the outcome-ledger line is built twice with already-drifted quoting (F6: `functions/api/[[path]].js:377-386` vs `:427-436`); `deriveReviewList` (`public/app.js:239-240`) re-implements `isNeedsReview` (`:234-237`) inline instead of `.filter(isNeedsReview)`.
- TODO density: zero. Literal search `TODO|FIXME|XXX|HACK|KLUDGE` over the repo: no matches. Positive control: the same search tool returns 8 worker `UNREVIEWED` sites and the `killed]` write sites, so the zero is real.
- Surface rules: PASS, no findings. Light-only (`public/styles.css:4` `color-scheme: light`; full 218-line read: no `prefers-color-scheme`, `data-theme`, or toggle); favicon linked (`public/index.html:9-10`, `public/favicon.svg` 269 bytes, 32×32 `$` on `#0d6b3f`); brand mark inline in header (`public/index.html:16`, same geometry/accent/glyph); guard test `public/tab-icon.test.mjs` green inside the suite. Live snapshot HTML matches (icon link, theme-color, brand SVG present).
- Working tree: `git status --short` empty before this file; `.gitattributes` pins `eol=lf`.
- Live snapshot `_night/live/aimoney_pages_dev_api_health.html:1` (rev `cdef1fbc…`, full 40-char SHA): `ok:true, db:up, opportunities:27, unreviewed:11, bare_without_brief:19, experiments_by_status:{planned:2}, hours_since_last_ok_run:4.5, oldest_unreviewed_age_h:178.2, decisions_last_7d:0, revenue_last_7d:null, revenue_total:null, spent_total:null, vetted_last_7d:0, last_vetted:null, vetted_no_experiment:0, noise_24h:0, health_probe_failures:[revenue_week,revenue_lifetime], health_probe_detail:{…:revenue_cents}, schema_missing_columns:[revenue_cents,spent_cents], schema_migration:disabled…`. Dashboard shell (121 lines) matches `public/index.html`.

## 4. Ranked findings (max 8)

Lane metric (aimoney): experiments reaching a decision (won/lost + post-mortem) per week, and vetted proposals becoming experiments; unreviewed backlog drained.

Money-first (owner directive), in this project's own numbers. This project is a tool the owner uses to rank and test AI-money ideas, not a product he sells; rank by decisions/week and owner minutes, measured the same way. The number, then and now: last audit (rev `eadb920`) — unreviewed 11, oldest 175.5h, `vetted_last_7d` 0, `decisions_last_7d` 0, money null. Now (rev `cdef1fbc`) — unreviewed 11, oldest 178.2h (+2.7h), `vetted_last_7d` 0, `decisions_last_7d` 0, money null. Nothing moved; the queue ages a day per day. Earned to date: none recorded — `revenue_total`/`revenue_last_7d`/`spent_total` null (unknown, not zero; probes cannot run without the columns), and no experiment has ever closed (`won`/`lost` absent from the lifetime status counts, which carry no date bound) with none running now. Last krone arrived: never recorded. Conversions at each step: unreviewed→vetted 0/11 over 7.4 days (0%), vetted→experiment n/a (0 vetted), planned→running 0/2 (0%), decisions 0/week. What would move it next: a human vets one row and Starts its zero-spend starter (2 taps), then runs it to won/lost with a human-entered amount. Honesty: no projection, no rate × volume, no attempt counted as outcome (signals ≠ proposals ≠ vetted; planned ≠ running). Prior focus directives verified DONE, not re-proposed: deploy-path schema convergence (CI `.github/workflows/deploy-worker.yml:33-34` + fail-fast `:20-26`, shared `deploy/apply-d1-migrations.sh`, convergence tests), default-off self-migration (`functions/api/[[path]].js:34-72`, `:555-571`), health probe isolation (`:517-546`), revision proof via single-source `release.json` (`deploy/verify.sh:62-106`, full SHA live in health).

### F1. Nothing automated was ever supposed to vet — the 11-row queue waits on a human press

Evidence. The path, in one sentence: a human presses Vet (dashboard button or `V` key), which PATCHes the row's notes to clear `UNREVIEWED` and append `[date vetted]` — `public/app.js:443`. The worker creates the marker (`worker/src/index.js:502`: `… UNREVIEWED, scores capped until a human vets it …`) and every other worker `UNREVIEWED` hit is create/count/select — no worker path clears it; `worker/src/index.js:4-5`: `The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed).` `README.md:71-72`: `A human admin vets each row` … `The agent never moves status.` The moving machinery is complete and phone-usable: inline Vet / Vet-&-starter / Kill per review row (`public/app.js:199-203`), decision + brief lines inline so no drawer round-trip (`:167`, `:181`), start-here Vet/Kill (`:124-131`), `V`/`K` with auto-advance (`:585-600`), pill queue mirror with jump (`:811-820`, `:861-866`). The real-path contract is pinned by test (`functions/api/api.test.mjs`, `vetting path Vet-PATCH-health` suite: Vet PATCH → health counts +1 with `last_vetted` today, green in this run). Live: `vetted_last_7d` 0, `last_vetted` null, unreviewed 11, oldest 178.2h, while `hours_since_last_ok_run` is 4.5 — the machine runs; no verdict was pressed. Inflow is correctly paused at 0/tick while unreviewed > 10 (`worker/src/index.js:425-428` + classify skip `:440`).

Why it costs: every stage of the lane metric is frozen (0 vetted → 0 started → 0 decisions/week, 2 planned stuck) and the queue can only drain through the press nobody has made in 7+ days.

Fix: no code fix exists for an unpressed button — this is the focus's stated good-answer branch, and the smallest clearing aid is already built (11 inline Vet taps, or 11 `V` keypresses, decision + brief inline). The implementer task is the queue clear itself (Task 1); the owner one-liner is in §5. Size S (human time, ~2 min + reading). Risk none (reversible token-gated PATCHes, one verdict per press, no bulk path anywhere).

### F2. Live money legs are null — the columns never reached D1 and the migration is disabled

Evidence. Live: `revenue_last_7d`/`revenue_total`/`spent_total` null, `health_probe_failures:[revenue_week,revenue_lifetime]`, `health_probe_detail:{…:revenue_cents}`, `schema_missing_columns:[revenue_cents,spent_cents]`, `schema_migration:disabled…`. The two failing probes are the only money readers (`functions/api/[[path]].js:501-502`). `d1/schema.sql:5` is `CREATE TABLE IF NOT EXISTS` (no-op on the existing table); the ADD COLUMNs live in `d1/migrate-2026-09-20-experiment-cents.sql:5-6` (+ `revenue_source` in `d1/migrate-2026-09-20-revenue-source.sql:5`), applied by CI and `deploy/deploy.sh:36,40` via the shared script — which never ran against live D1 (no `CF_API_TOKEN`/`CF_ACCOUNT_ID` repo secrets; fail-fast `.github/workflows/deploy-worker.yml:20-26`). The in-worker fallback is deliberately off: `functions/api/[[path]].js:53` unset → report missing + disabled, change nothing.

Why it costs: earned-to-date is unknown rather than zero, so the money-first question cannot be answered from the project's own data; lifetime and weekly money stay dark. (`decisions_last_7d` = 0 measured, saved by the COUNT split at `:500`.)

Fix: no code change; the path is already correct (isolation, column-only detail, ADD-only default-off self-migration, sorted shared migrations, convergence + positive-control tests — all green). The owner either sets `ALLOW_SCHEMA_MIGRATION=1` as a Pages env var (next `/api/health` adds exactly the two ADD COLUMNs one at a time and re-runs the failed probes on the same call; second run a clean no-op) or adds the two repo secrets and redeploys so CI applies the migrations. Exact CI step already in place: `.github/workflows/deploy-worker.yml:33-34` (`Apply D1 migrations in sorted order`). Touch no repo files. Size S. Risk none (ADD COLUMN with DEFAULT cannot lose a row; unset behaviour byte-identical).

### F3. Kill verdicts are invisible to health — clearing by killing still reads as a stall

Evidence. Kill writes `[YYYY-MM-DD killed] <post-mortem>` (`public/app.js:522`, drawer path `:999`) and clears `UNREVIEWED`, so `unreviewed` drops. But the `vetted_7d` probe matches only vetted tags (`functions/api/[[path]].js:503`: `notes LIKE '%[${d} vetted]%'`), and the `last_vetted` parse matches only vetted (`:604`: `/\[(\d{4}-\d{2}-\d{2}) vetted\]/g`). `decisions_last_7d` is experiments-only. Search confirms no health surface counts or dates kills (only writers + tests reference `killed]`).

Why it costs: agent proposals are often kill-worthy, so a real clearing session can end with `vetted_last_7d` 0 and `last_vetted` null — the next reader sees "never vetted, stall" though verdicts were recorded. The failure-visibility fix from the focus (last-verdict date) lies in the other direction for exactly the verdicts a triage session produces most.

Fix: report the last verdict including kills while keeping `vetted_last_7d` a pure vet count: widen the `last_vetted` probe/parse to take the max over `[date vetted]` and `[date killed]` tags (bounded tail unchanged), or add a parallel `last_verdict`; pin in `functions/api/api.test.mjs` via the real health path (kill-only row → verdict date today, `vetted_last_7d` still 0). Touch `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Size S. Risk low (read-only probe, null fallback preserved).

### F4. No experiment has ever closed and none is running — 2 planned, 0 started

Evidence. Live `experiments_by_status:{planned:2}` — the grouping carries no date bound (`functions/api/[[path]].js:498`), so `won`/`lost` would persist if any experiment had ever closed: none has. `decisions_last_7d` 0 (measured, `:500`). The starting machinery exists: one-click Start (`public/app.js:683` → PATCH planned→running stamps `started_at`), stall nudge naming the stalest open card, inline Win/Lose close with human-entered amount + source (`:344-414`), API closure gates (`functions/api/[[path]].js:337-342`, `:417-422`).

Why it costs: decisions/week is the lane metric and it cannot move while nothing runs; the two planned rows are the closest-to-money objects in the repo and both are idle.

Fix: owner action, no code change: press Start on the stalest planned card (one tap, token-gated), run it to won/lost with an entered amount and post-mortem. The Vet-&-log-starter chain (`public/app.js:473-507`) already links each future vet straight to its starter. Size S. Risk none.

### F5. Dashboard `api()` never times out — a hung request hangs the tap with no feedback

Evidence. `public/app.js:19-25`: `fetch(path, …)` with no `AbortController`/timeout; a hung Vet PATCH leaves no toast and no refresh. Contrast the worker, which times out everything: `timedJson` covers the body read (`worker/src/index.js:37-47`, 6s) and `aiComplete` races every model call (`:136-153`). Boot paints the last-good cache, so a hang strands an action, not the page — but on a flaky phone connection the vet tap (the money path) can die silently mid-queue-clear.

Why it costs: the queue clear in Task 1 happens on the owner's phone; a silent hang mid-session reads as a broken Vet button and stalls the funnel at its human gate.

Fix: race each dashboard `fetch` against an `AbortController` timeout (≈15s reads, ≈25s writes), surfacing the existing `${action} failed: …` toast + error banner path on abort; pin in `public/dashboard.test.mjs` with a never-resolving stub fetch. Touch `public/app.js`, `public/dashboard.test.mjs`. Size S. Risk low (timeout only converts a hang into the already-handled failure UI).

### F6. Outcome-ledger line built twice, already drifted in style

Evidence. `functions/api/[[path]].js:377-386` (create path: `String.fromCharCode(34)` quotes, notes UPDATE without `updated_at` touch) vs `:427-436` (update path: template literal, touches `updated_at`). Same `($X rev / $Y spent[ via …])` contract, two builders; the next money-format change must land in both or ledger lines diverge by close path.

Why it costs: the ledger line is the money-made-real record (amount + date + source on the parent row); a divergent format corrupts the one artefact the lane metric narrates from.

Fix: share one pure `outcomeLedgerLine({day, name, status, result, revenue_cents, spent_cents, revenue_source})` used by both paths (and align the `updated_at` touch); pin both close paths plus the shared builder in `functions/api/api.test.mjs`. Touch `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Size S. Risk low (string-level refactor, covered on both sides today).

## 5. What NOT to change

- The agent never vets, by documented design. `worker/src/index.js:4-5`: `The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed).` `README.md:72`: `researching → testing is a human decision … The agent never moves status.` Do not add auto-vet, auto-kill, or auto-testing without an owner-written rule, reversibility, and a real-path test.
- The self-migration stays default-off, ADD-only, triggerless. `functions/api/[[path]].js:16-25` (switch docblock), `:53` (unset → report + change nothing), `:59-67` (one ADD at a time, duplicate-column tolerated, anything else stays missing), once per isolate (`:35`, `:69-71`). Do not default it on, do not add a second trigger, and do not add a migration endpoint: `a URL that alters the schema is a liability even when it is authenticated.`
- Never a data-losing migration here: ADD only — `No DROP, no ALTER of an existing column, no data rewrite, no DELETE.`
- Cloudflare repo secrets are the owner's. The workflow fails fast with a named message until they exist (`.github/workflows/deploy-worker.yml:20-26`). His one line: Settings → Secrets → Actions → add `CF_API_TOKEN` and `CF_ACCOUNT_ID`, then redeploy.
- `ALLOW_SCHEMA_MIGRATION=1` is the owner's decision (a live-DB change); unset behaviour is byte-identical to today. His one line: set `ALLOW_SCHEMA_MIGRATION=1` as a Pages env var and reload `/api/health` once — the two money columns appear and the money legs fill on the same call.
- The 11-row queue clear is the owner's (needs `ADMIN_TOKEN` + human judgment per row). His one line: open `https://aimoney.pages.dev`, tap Needs review, tap Vet or Kill on each of the 11 rows oldest-first (`V`/`K` on desktop) — about two minutes plus reading.
- Starting/closing experiments is the owner's (needs the token + real outcomes). Never mark won/lost without `result` + `post_mortem` evidence, and never invent a revenue figure — the inline Win close takes a human-entered amount for exactly this reason.
- No writes to production D1 from any round: no `wrangler d1 execute … --remote`, no manual migration, no seed. Applying migrations live is the owner's action.
- `public/release.json`'s committed `dev-undeployed` placeholder is deliberate and fails loud: `deploy/verify.sh:88-89` FAILs a served placeholder immediately (test-pinned), and both stamp steps overwrite it at build/deploy time. Do not "fix" it with a hardcoded SHA — a wrong revision is worse than none.
- Never, whatever the ranking says: no spending, no account or identity creation, no outward sends, no accepting terms, no captcha solving, no fabricated reviews/receipts/testimonials, no scraping or messaging a platform's terms forbid, no financial advice or implied return.
- House rules honored by this audit: never read `.env`/secrets/tokens; no edits to existing files (this findings file only); single-stage shell commands only, no inline code, no redirection.

## 6. Proposed next tasks (2–4)

### Task 1. Vet-or-kill all 11 unreviewed via dashboard; leave review queue empty

Owns: live dashboard + D1 via the API (no repo files changed). Context (F1 — the focus's explicit round): the only unreviewed→vetted path is the manual Vet press (`public/app.js:443` via `vettedNotes` `:423` → `PATCH /api/opportunities/:id`); the worker never vets by design, and the smallest clearing aid is already built (inline Vet / Vet-&-starter / Kill per row, `V`/`K` + auto-advance, decision + brief lines inline, no drawer round-trip). A human opens the Needs-review filter oldest-first and records Vet (or Vet-&-starter for rows worth testing) vs Kill with a one-line post-mortem per row.

Acceptance: `/api/health` reads `unreviewed` 0, `oldest_unreviewed_age_h` null, `last_vetted` today (or every verdict a `[date killed]` + post-mortem — see Task 2 for why kills stay visible); every Vet carries `[YYYY-MM-DD vetted]`, every Kill a one-line post-mortem; next cron resumes inflow (unreviewed ≤ 10 → cap 2/tick). Requires `ADMIN_TOKEN` and human judgment per row; never mark decided without evidence.

### Task 2. Count Kill verdicts in health verdict date; keep vetted count pure

Owns: `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Context (F3): kills clear `UNREVIEWED` but match neither the `vetted_7d` probe (`:503`) nor the `last_vetted` parse (`:604`), so a kill-heavy clearing session still reports `vetted_last_7d` 0 / `last_vetted` null. Widen the verdict-date probe/parse to max over `[date vetted]` and `[date killed]` (bounded tail unchanged) without touching `vetted_last_7d` semantics.

Acceptance: real-path health test — a kill-only row reports today's verdict date while `vetted_last_7d` stays 0; a vetted row still reports via its tag; no-vetted-no-killed still null; `npm test` green.

### Task 3. Time out dashboard API calls so a hung Vet tap fails visibly

Owns: `public/app.js`, `public/dashboard.test.mjs`. Context (F5): `api()` (`:19-25`) has no timeout, so a hung request on a flaky connection strands the queue-clear tap with no toast. Race each fetch against an `AbortController` timeout and route aborts into the existing failure toast + banner path.

Acceptance: a never-resolving stub fetch produces the named failure UI within the timeout (reads and Vet PATCH alike); normal fast paths unchanged; `dashboard.test.mjs` covers abort + toast; `npm test` green.

### Task 4. Share one outcome-ledger builder between experiment close paths

Owns: `functions/api/[[path]].js`, `functions/api/api.test.mjs`. Context (F6): the `($X rev / $Y spent[ via …])` ledger line is built twice with drifted quoting (`:377-386` vs `:427-436`). Extract one pure builder used by both create-close and update-close, align the `updated_at` touch, and pin both paths in tests.

Acceptance: POST-close and PATCH-close emit byte-identical ledger lines for identical input (incl. `via {source}` and `$0.00` defaults); editing a closed row still appends nothing; `npm test` green.
