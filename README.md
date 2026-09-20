# AIMoney Lab

A Cloudflare-native system for finding, ranking, and testing ways of making
money with AI:

- **Priority list** — every known AI-money opportunity, scored and ranked
  (expected value, effort, confidence, fit). This is the page you open daily.
- **Research briefs** — evidence behind each score: what works, numbers,
  risks, first steps.
- **Experiments** — strategies under test: hypothesis, cost, metric, result.
  Kill or scale based on data, then re-optimize the list.
- **Research agents** — a scheduled Cloudflare Worker (cron) that continuously
  scans public sources (HN, Reddit, GitHub), proposes new
  opportunities, refreshes briefs, and re-scores the list with Workers AI.
  Every agent run is logged and visible on the dashboard.

## Stack (matches the other deployments)

| Piece | What | Config |
|---|---|---|
| Dashboard | Cloudflare Pages, static `public/` + `scripts/stamp-release.sh` build | `wrangler.toml` |
| API | Pages Functions (`functions/api/`) + D1 | `wrangler.toml` |
| Research agent | Worker + Cron Trigger + Workers AI + D1 | `worker/wrangler.toml` |
| Database | D1 (`aimoney`) | `d1/schema.sql`, `d1/seed.sql` |
| Infra manifest | hosts, services, URLs, checks | `deploy/public-surfaces.json` |

Live surfaces (after deploy):

- Dashboard: `https://aimoney.pages.dev`
- API health: `https://aimoney.pages.dev/api/health`
- Research worker: `https://aimoney-research.<account>.workers.dev`

## Quick start

```sh
# 1. Auth (values never enter version control)
export CLOUDFLARE_ACCOUNT_ID=97120bae9770152d66a6881976a2a2d4
export CLOUDFLARE_API_TOKEN=<token with Pages + Workers + D1 + AI edit>

# 2. Create the D1 database once, then put the id in both wrangler.toml files
wrangler d1 create aimoney
wrangler d1 execute aimoney --file=d1/schema.sql
wrangler d1 execute aimoney --file=d1/seed.sql

# 3. Deploy everything (Pages site + research worker), then verify
./deploy/deploy.sh
./deploy/verify.sh
```

Admin writes (add opportunity, update status, trigger research) need a bearer
token: set `ADMIN_TOKEN` as a Pages environment variable (and worker secret),
then enter it once in the dashboard — it is kept in `localStorage` only.

## How the priority score works

`score = 100 * (value * confidence * fit) / (effort + 1)`, each input 1–10:

- **value** — realistic monthly revenue at modest scale (10 ≈ $10k+/mo)
- **effort** — weeks of focused work to first dollar (10 ≈ 6+ months)
- **confidence** — strength of evidence (10 = multiple verified case studies)
- **fit** — leverage of your existing stack (automation, bots, content engines)

Status flow: `backlog → researching → testing → scaling | paused | killed`.
Killed strategies stay on the board with their post-mortem — that is the point.
Agent proposals enter as `researching` with an `UNREVIEWED` marker in notes and an effective score capped to ≤6000 until a human vets them (shared `effectiveScore` in `worker/src/lib.js`, used by both worker and API). Each proposal carries rough `est_monthly_low`/`est_monthly_high`, `capital_needed`, and `time_to_first_dollar` estimates from the same triage call — missing keys default to 0/0/''/'', inverted ranges clamp high up to low, zero-spend phrasings ("free"/"none"/bare "0") normalize to "$0 …"-form with the raw phrasing kept, and notes are tagged `agent estimates — correct on vet`; every field stays human-editable in the drawer, so the estimate is reversible at vet time.

## Review flow (who vets, what moves)

- The Priority tab opens with a "Start here today" strip — the #1-by-score actionable opportunity (killed and paused rows skipped, scaling stays eligible) with its $/mo range, capital to start, and the brief's first next action (one click opens its drawer) — plus a "Zero spend" chip filtering to rows whose capital need reads as $0 ("$0", bare "0", "free", or "none").
- The Priority tab's "Needs review (N · oldest 3d)" chip lists agent proposals oldest-first (`GET /api/opportunities?unreviewed=1&sort=oldest`); the age comes from `oldest_unreviewed_age_h` in `/api/health`.
- A human admin vets each row: "Vet" clears the `UNREVIEWED` marker (keeps status, lifts the 6000 cap) and appends a `[YYYY-MM-DD vetted]` tag that `/api/health` counts as `vetted_last_7d`; the success toast offers one-click "Log experiment" so a vetted row links straight to its next experiment. "Kill" sets `killed` and requires a one-line post-mortem in notes. The drawer offers the same Vet/Kill for unreviewed rows, and its admin status-to-`killed` save prompts for the same post-mortem instead of saving directly.
- `researching → testing` is a human decision: flip to `testing` when you start a real experiment (log it on the Experiments tab, move it `planned → running`). The agent never moves status.
- The Experiments tab sorts each column stale-first with `Nd` age chips on `planned`/`running` cards (`days_in_status` from `/api/experiments`); an experiment whose opportunity was deleted keeps its card with an `orphaned` pill instead of vanishing.
- Closing an experiment as `won`/`lost` requires `result` + `post_mortem`; `ended_at` stamps automatically. `running` stamps `started_at` when empty. The same closure rules, stamps, invalid-status 400, and outcome-ledger append apply when creating an experiment (plus a 404 on unknown `opportunity_id`); creating and updating an opportunity rejects bad ranges, updating with an invalid status 400s, and creating a brief 404s on unknown parent. The range rule rejects `est_monthly_low > est_monthly_high`. Closing via create or update appends a one-line `[date outcome]` entry with `$X rev / $Y spent` from the closed row's cents to the parent opportunity notes (score untouched); the drawer admin zone then offers a suggested ±1 value/confidence rescore the human applies with one click — never auto-applied. Experiments record precise `revenue_cents`/`spent_cents` (dollars in the modal, integer cents in the API; board and drawer cards show the $ figures (drawer adds the ended date)), and `/api/health` sums `revenue_last_7d` in cents from rows closed `won`/`lost` in 7d. The Add opportunity modal asks for $/mo low–high, capital needed, and time to first $ so manual adds match the `Zero spend` filter and EV ranking.
- The Experiments header shows `X decisions this week · Y vetted this week → Z total experiments · $W revenue this week` from `/api/health` (`decisions_last_7d` = `won`/`lost` with `ended_at` in 7d; `vetted_last_7d` = vetted-tag rows touched in 7d; `revenue_last_7d` = cents from rows closed `won`/`lost` in 7d, hidden when the key is absent on old backends), plus `N vetted, no experiment` (`vetted_no_experiment`) when vetted rows still lack an experiment. When the week has zero decisions, the header nudges with the stalest open card's name and age (one click opens its drawer) — read-only, no auto-transitions.
- Triage takes the oldest unprocessed signals first (6 per run); signals older than 30d are swept to noise with a count so ancient backlog cannot wedge the queue. On slug collision the worker links the signal to the existing row as supports — reversible, notes newest-kept, no status move.
- Manual `Run triage now (briefs on cron)` collects and triages only (`POST /run` 202 carries `briefs_skipped:true`); briefs land on cron ticks — even with zero fresh signals, when only the classify call is skipped — one bare row (oldest-unreviewed-first when the oldest unreviewed exceeds 48h, otherwise top-scored; the run log shows the brief mode) plus, when the oldest unreviewed exceeds 48h, one extra second-oldest bare row. The agent pill and Research log show added/updated with 24h triage noise from health.
- Scores stay honest everywhere: the drawer shows the same capped score as the ledger with a "(capped — unreviewed)" marker until a human vets the row, and rows without a brief carry a "no brief" pill in the score cell (the review chip tooltip counts them).
- A failed API fetch shows a named error banner with Retry (and `db down` turns the agent pill red) instead of an empty board; `testing · 0 experiments` and `running exp · opp still researching` badges flag status mismatches read-only — the human still owns every status move.

## Seed vs live counts

- `d1/seed.sql` inserts 12 researched opportunities. Live boards show more (e.g. 40) because the research agent appends proposals every 6h and humans add rows. Seed runs once on an empty table; live count = 12 seeds + agent proposals + manual adds. Killed rows stay listed, so the count only grows.

## Token rotation

- `ADMIN_TOKEN` lives in two places: the Pages env var and the worker secret (`wrangler secret put ADMIN_TOKEN --config worker/wrangler.toml`). The dashboard keeps a copy in `localStorage` (`aimoney_admin`).
- To rotate: set the new value in the Pages env + worker secret, redeploy both, then re-enter it in the dashboard via the Admin button. Old browsers keep the old token until replaced. No expiry; rotate manually when shared or leaked.

## Repo layout

```
public/            Pages site (no build step)
functions/api/     REST API (D1 backend)
worker/src/        cron research agent (Workers AI)
d1/                schema.sql + seed.sql
deploy/            deploy.sh, verify.sh, public-surfaces.json (infra manifest)
.github/workflows/ worker auto-deploy on push (Pages auto-deploys via Git)
scripts/           local helpers (seed regeneration, backfill)
```
