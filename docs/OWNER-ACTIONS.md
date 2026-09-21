# Owner actions (one page)

Everything below needs the human owner — no code, cron tick, or agent run can
do it. Three actions, in order. Dashboard: `https://aimoney.pages.dev`;
numbers below all come from `https://aimoney.pages.dev/api/health`.

## 1. Clear the Needs-review queue (11 rows, oldest 7.5 days)

Action: open the Priority tab, click the `Needs review (N · oldest Nd)` chip
(or the agent pill, which jumps to the same filter), and press one verdict per
row — `V` vets the focused row, `K` opens its inline Kill post-mortem (Confirm
kills) — or click `Vet` / `Vet & log starter` / `Kill` on each row. Rows list
oldest-first with the capital/next/source decision line and the brief line
inline, so no drawer round-trip is needed; each `V`/`K` auto-advances to the
next unreviewed row. About a minute a row, works from a phone.

See the result in `/api/health`: `unreviewed` drops by one per verdict,
`vetted_last_7d` rises by one per Vet, `last_vetted`/`last_verdict` become
today. While `unreviewed` stays above 10, cron inserts nothing
(`inflow:paused`) — clearing the queue reopens the funnel.

## 2. Set the migration switch so the money fields report

Action: in the Cloudflare dashboard, open the Pages project → Settings →
Environment variables → add `ALLOW_SCHEMA_MIGRATION=1` to production, then
retry the latest deployment so the new var takes effect. That is the whole
change — no code, no script, no database command.

See the result in `/api/health` on the very next call: the two missing money
columns are added, `revenue_last_7d`/`revenue_total`/`spent_total` report
numbers instead of null, and `schema_missing_columns` plus the
`schema_migration: disabled …` line disappear. Until then every revenue/spend
figure is honestly unknown (null), never $0.

## 3. Start one $0 experiment and drive it to a decision

Action: click the `Zero spend` chip, pick the cheapest row, press
`Vet & log starter` (vets the row, creates a prefilled planned starter
experiment, flips the row to `testing`), open the Experiments tab, press
`Start` on the planned card, run the smallest real-world test inside a week,
then close it with `Win` (human-entered $ revenue, optional spend and
`via {source}`) or `Lose` — both require a one-line result + post-mortem.

See the result in `/api/health`: `experiments_by_status` shows the row moving
`planned → running → won/lost`, `decisions_last_7d` rises by one (the lane
metric), and `revenue_total` shows the entered $ figure on the lifetime leg.

No spending, no new accounts, no messages or posts, no accepted terms — draft
and queue only. Never enter a $ figure without evidence behind it.
