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
  scans public sources (HN, Reddit, arXiv, GitHub), proposes new
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
