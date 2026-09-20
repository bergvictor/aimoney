-- Additive migration: precise money on experiments (audit 2026-09-20 Task 4).
-- revenue_cents/spent_cents default 0 so existing rows and reads are unaffected.
-- Applied by deploy.sh after schema.sql; on re-deploy SQLite errors on the
-- duplicate ADD COLUMN and deploy.sh tolerates that (keeps the rollout green).
ALTER TABLE experiments ADD COLUMN revenue_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE experiments ADD COLUMN spent_cents INTEGER NOT NULL DEFAULT 0;
