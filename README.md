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
Agent proposals enter as `researching` with an `UNREVIEWED` marker in notes and an effective score capped to ≤6000 until a human vets them (shared `effectiveScore` in `worker/src/lib.js`, used by both worker and API).

## Review flow (who vets, what moves)

- The Priority tab's "Needs review (N · oldest 3d)" chip lists agent proposals oldest-first (`GET /api/opportunities?unreviewed=1&sort=oldest`); the age comes from `oldest_unreviewed_age_h` in `/api/health`.
- A human admin vets each row: "Vet" clears the `UNREVIEWED` marker (keeps status, lifts the 6000 cap); "Kill" sets `killed` and requires a one-line post-mortem in notes.
- `researching → testing` is a human decision: flip to `testing` when you start a real experiment (log it on the Experiments tab, move it `planned → running`). The agent never moves status.
- The Experiments tab sorts each column stale-first with `Nd` age chips on `planned`/`running` cards (`days_in_status` from `/api/experiments`); an experiment whose opportunity was deleted keeps its card with an `orphaned` pill instead of vanishing.
- Closing an experiment as `won`/`lost` requires `result` + `post_mortem`; `ended_at` stamps automatically. `running` stamps `started_at` when empty.

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
