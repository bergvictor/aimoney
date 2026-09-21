# AUDIT-2026-09-20-round2 — aimoney (read-only, 2026-09-21)

Clone HEAD `4a9d315` (one commit ahead of live rev `4deb704`). Live snapshot from `_night/live`
(fetched by the runner): `opportunities 27 | unreviewed 11 | bare_without_brief 19 |
vetted_last_7d 0 | decisions_last_7d 0 | revenue_* null | oldest_unreviewed_age_h 174.8 |
hours_since_last_ok_run 1.1`, probe failures `revenue_week, revenue_lifetime`, migration disabled.
No AGENTS.md/CONTRIBUTING/CLAUDE.md exists in the repo; README.md is the contract.

## 1. What this project is and how it runs

AIMoney Lab ranks AI-money opportunities, keeps research briefs, and tracks experiments until each is won/lost with a post-mortem.
Entry points: static dashboard `public/` + Pages Functions API `functions/api/[[path]].js` + research worker `worker/src/index.js` (`/`, `/run`, `/ping-ai`, `/debug-classify`).
Live surfaces: `https://aimoney.pages.dev`, `/api/health`, `/api/opportunities`, `/api/runs`, worker `https://aimoney-research.levitinvlad.workers.dev/` (`deploy/public-surfaces.json:32-45`).
One scheduled job: worker cron `0 */6 * * *` (`worker/wrangler.toml:8-9`) — collect signals, triage with Workers AI, brief bare rows.
Deploys: Pages auto-deploys `public/` via Git (build command only stamps `release.json`, `deploy/public-surfaces.json:9`); worker via `deploy/deploy.sh` or CI `.github/workflows/deploy-worker.yml`; `deploy/verify.sh` checks markers + live revision.

## 2. End-to-end walk-through

Signal → proposal → brief → human vet → experiment → decision (money). Hop by hop:

1. Cron fires `scheduled` (`worker/src/index.js:589-597`) → `runResearch(env, "cron")` (`:280`); stuck `running` rows reaped (`:284-289`).
2. Collect: HN/Reddit/GitHub in parallel (`:315`), one batched signal INSERT (`:326-331`); 30d+ unprocessed signals swept to noise (`:340-344`).
3. Take oldest 6 unprocessed (`:346-348`); exact-URL matches link as supports with no AI call (`:354-380`).
4. One classify call (`@cf/mistral/mistral-7b-instruct-v0.1`, `:12`, `:391-402`); verdicts validated (`:405-437`); at most 2 new rows (1 while bare>10, `:406-414`), inserted as `researching` + `UNREVIEWED`, score capped ≤6000 (`:438-477`); supports/noise queued (`:478-490`); writes flushed as one batch with per-write fallback (`flushVerdictWrites`, `:263-279`), flushed at `:491`.
5. Brief pass on cron only (manual always skips, `:313`): top-scored, or oldest-unreviewed-first past 48h (`:493-533`), plus one extra oldest-unreviewed bare row past 48h (`:540-572`); single run-log write (`:575`).
6. Dashboard lists via `GET /api/opportunities` (`functions/api/[[path]].js:113-155`); health via 12-probe batch + isolation fallback (`:447-606`).
7. **THE VET PATH (focus Q1): a manual button.** Human taps Vet (`public/app.js:429-449`) or Vet & log starter (`:457-491`), which writes the `[YYYY-MM-DD vetted]` tag via `vettedNotes` (`:409-412`) through `PATCH /api/opportunities/:id` (`functions/api/[[path]].js:207-248`); health counts the tags (`:473-476`, `:563-575`). Nothing automated was ever supposed to vet: the worker header says it "PROPOSES; the human owns the testing workflow (it never moves status…)" (`worker/src/index.js:1-5`), README says "The agent never moves status" (`README.md:72`), and a repo-wide search shows the only writer of the vetted tag in shipped code is `public/app.js:411` (worker: zero hits; API: reads only).
8. Experiment: `POST /experiments` → `planned` (`:324-373`), Start → `running` (stamps `started_at`), close → `won/lost` requires `result` + `post_mortem`, stamps `ended_at`, appends an outcome-ledger line with `$X rev / $Y spent` (`:402-431`); health sums money from closed rows (`:471-472`).

Where it most often breaks or goes silent, in order: (a) the dashboard script does not parse at all (F1) — every tap below is unreachable; (b) the human vet tap never happens (F2) — the queue ages 1 day/day; (c) money columns missing in live D1 null the revenue probes (F3); (d) AI budget (`MAX_AI_CALLS = 4`, `:18`) and per-source outages degrade a tick to `src_fail`/`brief:failed` markers rather than silence.

## 3. Health signals measured here

- `npm test` (this session, exit 0): **332 tests / 113 suites, 332 pass, 0 fail** (`duration_ms 1422.7`). Matches the Windows baseline in `_night/tests-baseline.log` (332/332, `duration_ms 328.9`). The suite is green **with a SyntaxError in the shipped dashboard bundle** — that is F5, not health.
- `node --check worker/src/index.js` → exit 0. `node --check worker/src/lib.js` → exit 0.
- `node --check public/app.js` → **exit 1, SyntaxError**: `Missing } in template expression` at `public/app.js:1222` (exact line in F1).
- `functions/api/[[path]].js` could not be `node --check`ed directly (bracket path trips sandbox approval), but it is imported by `functions/api/api.test.mjs` inside the green run (the `MODULE_TYPELESS_PACKAGE_JSON` warning names it), so it parses. Stated, not assumed.
- TODO density: **0** hits for `TODO|FIXME|XXX|HACK|BUG:` across the repo (excluding `node_modules`, `_night`, `.git`, `docs`).
- Dead code: none found on shipped paths — every import is used at its call sites; `console.*` in the worker is only the deliberate `cron-failed` tail markers (`worker/src/index.js:583,595,659`). One stale note: `functions/api/[[path]].js:83-84` ("local duplicate removed") is a leftover comment, harmless.
- Duplication: largely eliminated (shared `effectiveScore`, `tokensMatch`, `vettedNotes`, classify/brief prompt+parse+insert builders). Remainder: `clamp10` still copied in the API (F8).
- Line endings: this clone is LF (`file` reports no CRLF on `public/app.js`, `worker/src/index.js`; `.gitattributes` pins `eol=lf`). The `:1222` break is a dropped-`}` edit error, not a CRLF artifact.
- Surface rules (owner's 5): **pass**. Served HTML ships `color-scheme: light`, no dark branch (`public/styles.css:4`; no `prefers-color-scheme` hit), favicon + `theme-color` (`public/index.html:9-10`), inline brand mark (`:16`), and the `tab-icon` guard suite is 5/5 green. No surface finding this round.

## 4. Ranked findings (max 8)

Money first (owner directive), in numbers from this project's own data: **earned to date: none** — zero experiments ever closed (`decisions_last_7d 0`, `experiments_by_status {"planned": 2}`), so no recorded revenue exists and the last krone arrived **never**. (`revenue_total` reads `null`, unknown, because the money probes fail — F3 — but with zero `won/lost` rows there is nothing to sum either way.) The single step to the next payment: vet one row → start its zero-spend starter → close it `won` with `revenue_cents` + `revenue_source`. Measured conversion at that step: **unmeasured** — 0 vetted and 0 decisions in 7d is an empty funnel (0/0), not a 0% rate. aimoney is **a tool the owner uses, not a product he sells**; rank below by owner-time saved and experiments decided per week. No projection is presented as a result anywhere in this file.

**F1. The dashboard script is dead on live — one dropped `}` kills every Vet tap. (P0)**
Evidence: `public/app.js:1222` reads `` el.innerHTML = `${parts.join(" ") <button id="api-retry" …` `` — the `}` after `parts.join(" ")` is missing; `node --check` exits 1 (`Missing } in template expression`). Commit `7420a40` (2026-09-21 07:42) shows the before/after: the old line had `${parts.join(" ")} <button`, the new one drops the brace. Live rev `4deb704` contains it: `git diff 4deb704 HEAD -- public/app.js` touches only lines 403–470, and no commit between `7420a40` and HEAD touched `app.js` again — so the break has shipped to every deploy since 07:42. The page loads it as a classic deferred script (`public/index.html:119`), so one parse error kills the whole bundle: no ledger, no review strip, no Vet/Kill/Start — the shell sits on "Loading priority list…" forever.
Why it costs money/users/trust: the entire review flow (F2's only path) is unreachable from the UI the owner actually opens; every other improvement tonight is moot until this parses.
Fix: restore the `}` (one character) in `public/app.js:1222`, then add a test that parses every shipped JS file from disk with a broken-syntax fixture as positive control (see task 1). Files: `public/app.js`, `public/dashboard.test.mjs` (or a new parse-gate test file). Size S. Risk: low — one-character restoration plus a gate.

**F2. Nothing automated was ever supposed to vet — the 7-day stall is the owner bottleneck. Saying so plainly.**
Evidence: the vet path is the manual button in hop 7 above (`public/app.js:429` / `:457` → tag at `:411` → `PATCH` at `functions/api/[[path]].js:207`). The worker never writes a verdict by design (`worker/src/index.js:1-5`, `README.md:72`). `vetted_last_7d 0` with `hours_since_last_ok_run 1.1` is therefore not a stuck guard, an exhausted budget, or a swallowed exception — something runs (triage + briefs) and vetting was never its job. Note the honest split: the 7-day stall predates F1 (F1 broke today at 07:42); F1 now blocks the remedy.
Why it costs money/users/trust: the queue (`unreviewed 11`, oldest 174.8h and rising 1/day) drains only through taps nobody has made; machinery rounds cannot move it.
Fix: no code. Fix F1, then the owner clears all 11 rows in one pass with the already-built one-tap "Vet & log starter" / Kill (≈10 min, task 4). Do not bulk-vet and do not automate verdicts — one reversible human decision per tap. Size S (an owner session, not code). Risk: verdict quality if rushed; mitigated by keeping per-row taps.

**F3. Money probes fail live; both remaining moves are owner-only switches — no code left to write.**
Evidence: live health names `health_probe_failures ["revenue_week","revenue_lifetime"]` with `schema_missing_columns ["revenue_cents","spent_cents"]` and `schema_migration "disabled (set ALLOW_SCHEMA_MIGRATION=1 to add missing columns)"`. The self-migration is correctly default-off (`functions/api/[[path]].js:53`), the deploy convergence already ships one sorted migration list (`deploy/apply-d1-migrations.sh`, called by `deploy/deploy.sh:37` and `.github/workflows/deploy-worker.yml:33-37`), and CI fails fast without secrets (`deploy-worker.yml:20-26`).
Why it costs money/users/trust: `revenue_last_7d`, `revenue_total`, `spent_total` read `null`, so the dashboard cannot distinguish "$0" from "unknown" — the exact wrong-number class the money directive bans.
Fix (owner picks one line, both already built): set Pages env var `ALLOW_SCHEMA_MIGRATION=1` so the next health check ADDs the two columns, or add `CF_API_TOKEN`/`CF_ACCOUNT_ID` to repo secrets so CI converges the schema. Files: none in repo. Size S. Risk: low — ADD COLUMN with DEFAULT cannot lose rows; still the owner's call.

**F4. HEAD's `last_vetted` stall-age key is undeployed — live still hides the stall's age.**
Evidence: the saved live payload (rev `4deb704`) has no `last_vetted` key; HEAD `4a9d315` ships the 12th probe, JS-parsed max tag, and payload key (`functions/api/[[path]].js:563-575`, `:605`), one commit ahead of live.
Why it costs money/users/trust: the next reader of the live endpoint still needs to be told the pipeline stalled; the "say when the last verdict was recorded" half of the focus is built but not serving.
Fix: deploy HEAD to Pages after F1 lands, then `./deploy/verify.sh`. Owned by the orchestrator/owner (network + production write), not this lane. Size S. Risk: deploys a one-char fix plus a read-only probe; verify gates the revision.

**F5. No gate parses the shipped JS — tonight's check-that-passes-by-matching-nothing.**
Evidence: `public/dashboard.test.mjs:145` asserts `js.includes("api-retry")` on unparsed text — passes on the broken file; all 332 tests pass with the SyntaxError present; `deploy/verify.sh:32` greps `app.js` for the substring `renderLedger`, which the broken file still contains, so verification would pass a dead dashboard too; there is no build step that could catch it (`deploy/public-surfaces.json:9` — "no framework build", the stamp script only writes `release.json`). Positive control performed by this audit: `node --check` on the four shipped JS files — 2 pass, 1 fails, 1 proven by import (section 3).
Why it costs money/users/trust: this exact failure class re-ships silently on the next fragment edit.
Fix: task 1 (test parses shipped JS + broken fixture must fail) and task 2 (verify parses `app.js` instead of grepping it). Files: `public/dashboard.test.mjs`, `deploy/verify.sh`, `deploy/deploy.test.mjs`. Size S. Risk: low — gates only.

**F6. The funnel below the queue is empty: 2 planned, 0 running, 0 won/lost — the first number never arrives.**
Evidence: live `experiments_by_status {"planned": 2}`, `decisions_last_7d 0` across consecutive snapshots; closure requires `result` + `post_mortem` (`functions/api/[[path]].js:402-407`), which nothing has ever supplied.
Why it costs money/users/trust: the lane metric (experiments decided/week) cannot move; without a first closed experiment there is no measured conversion and no revenue figure that is honest to print.
Fix: no code. Smallest concrete zero-spend experiment, using parts already built: "Vet & log starter" on the #1 zero-spend row (prefilled metric "replies; revenue", `public/app.js:478-479`), tap Start, run one week counting replies and revenue, close `won`/`lost` with a one-line post-mortem. Never invent a revenue figure; never close without evidence. Size S (owner + one week). Risk: none to code; the risk is a second planned row that never starts — the Start tap is the commitment.

**F7. The review queue is brief-less (19/27 bare), so each Vet is low-information.**
Evidence: live `bare_without_brief 19` against `unreviewed 11`; bare review rows read "No brief yet" (`README.md:78`). Drain rate is ≤2 briefs per 6h tick (main + extra, `worker/src/index.js:493-572`), oldest-unreviewed-first past 48h (`:504-511`) — about 6 ticks (~36h) to cover 11 rows once F1/F2 unblock the owner.
Why it costs money/users/trust: the owner either vets blind (weak verdicts, weak starters) or waits (queue ages further).
Fix: no code required — let cron briefs catch up; if the queue still outruns briefs, add the reversible inflow pause in task 3 (cap inserts to 0 while unreviewed > 10; overflow signals stay unprocessed for a later tick). Files if gated: `worker/src/index.js`, `worker/src/index.test.js`, `README.md`. Size S. Risk: low — pausing inflow slows discovery but loses nothing (reversible by design).

**F8. `clamp10` is the last unshared helper — API-local copy can drift from the worker's.**
Evidence: `functions/api/[[path]].js:74-78` defines its own `clamp10` while importing `effectiveScore`/`tokensMatch` from `worker/src/lib.js:4-7` (`[[path]].js:10`); every sibling helper is already shared.
Why it costs money/users/trust: rounding/fallback semantics can diverge silently between scorer and API (score disputes, not outages).
Fix: import `clamp10` from `worker/src/lib.js`, delete the local copy, pin input/output parity in `functions/api/api.test.mjs`. Size XS. Risk: trivial.

## 5. What NOT to change

- The worker never auto-vets and never moves status ("The agent PROPOSES; the human owns the testing workflow (it never moves status to testing/scaling/killed)", `worker/src/index.js:1-5`; "The agent never moves status", `README.md:72`). Deliberate — do not automate verdicts.
- The self-migration stays default-off, ADD-only, with no endpoint ("If the variable is not set, change nothing"; "ADD only. No DROP, no ALTER of an existing column, no data rewrite, no DELETE"; `functions/api/[[path]].js:16-25`). Deliberate — do not default it on or add a trigger.
- Credentials and switches are the owner's: add `CF_API_TOKEN`/`CF_ACCOUNT_ID` to repo secrets (CI fails fast without them, `.github/workflows/deploy-worker.yml:20-26`); set Pages env `ALLOW_SCHEMA_MIGRATION=1` to converge the money columns (live payload line); `ADMIN_TOKEN` rotation is manual with no expiry (`README.md:85-88`). Never read, print, or commit secret values.
- No spending, no accounts, no outward sends, no accepting terms (task boundaries). The first experiment must be zero-spend.
- Vet/Kill verdicts are human decisions ("A human admin vets each row", `README.md:71`). An implementer must not fabricate verdicts, post-mortems, or revenue figures to move the queue.
- Killed rows stay listed with post-mortems (`README.md:64`); seed applies once to an empty table (`deploy/deploy.sh:50-55`) — never re-seed a live table.
- `public/release.json` reads `{"project":"aimoney","revision":"dev-undeployed",…}` in the repo (`public/release.json:1`) by design — the build stamps it, and `deploy/verify.sh:68-70` fails a deploy that serves the placeholder. Do not hardcode a revision.

## 6. Proposed next tasks (2–4)

- [ ] **Task 1 — Repair app.js SyntaxError at :1222 and add a shipped-JS parse test.** (F1, F5; the focus's vet-path fix: the path is the manual Vet button at `public/app.js:429`, the cause is the dropped `}` proven by a test that fails before and passes after.) Owned files: `public/app.js`, `public/dashboard.test.mjs` (or a new parse-gate test). Acceptance: restore `}` so the line reads `` `${parts.join(" ")} <button…` ``; `node --check` exits 0 on every shipped JS file (`public/app.js`, `functions/api/[[path]].js`, `worker/src/index.js`, `worker/src/lib.js`); a new test parses `app.js` from disk and fails on a broken-syntax fixture (positive control) and passes on the fixed file; `npm test` 332+ green.
- [ ] **Task 2 — verify.sh must parse app.js: fail the rollout when the dashboard JS has a syntax error.** (F5.) Owned files: `deploy/verify.sh`, `deploy/deploy.test.mjs`. Acceptance: the `dashboard-appjs` check requires `app.js` to parse as JS (not merely contain `renderLedger`); it fails on `7420a40`'s `app.js` bytes and passes on the fixed file; all existing marker, revision-gate, and freshness checks unchanged and green.
- [ ] **Task 3 — Cap worker inserts to 0 while unreviewed exceeds 10; overflow stays unprocessed.** (F7; drains the queue at the top, reversibly.) Owned files: `worker/src/index.js`, `worker/src/index.test.js`, `README.md` (one line beside the bare-backlog gate). Acceptance: a run with >10 unreviewed inserts 0 new rows and leaves overflow signals `processed = 0` for a later tick; ≤10 keeps today's caps (2, or 1 while bare > 10); AI budget, verdict validation, status rules, and manual brief-skip unchanged; test drives the real run path against a stubbed D1, not a helper unit test.
- [ ] **Task 4 (owner, ~10 min, no code) — Owner vet pass: clear all 11 unreviewed rows via Vet-starter or Kill.** (F2, F6.) Owned files: none — dashboard UI only, after tasks 1–2 deploy. Acceptance: `unreviewed` 0, `vetted_last_7d` 11 (minus kills), `last_vetted` today on `/api/health`; each kept row leaves with a starter experiment via one-tap "Vet & log starter", each rejected row with a one-line post-mortem. One reversible human decision per tap; no bulk actions.
