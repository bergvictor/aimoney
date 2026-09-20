-- Additive migration: revenue source on experiments (audit 2026-09-20-round2 Task 3).
-- revenue_source defaults '' so existing rows and reads are unaffected.
-- Applied by deploy.sh after schema.sql; on re-deploy SQLite errors on the
-- duplicate ADD COLUMN and deploy.sh tolerates that (keeps the rollout green).
ALTER TABLE experiments ADD COLUMN revenue_source TEXT NOT NULL DEFAULT '';
