-- Additive migration: 30d-sweep marker on signals (audit 2026-09-26-round3 Task 3).
-- swept defaults 0 so existing rows and reads are unaffected; the worker's
-- stale sweep sets swept = 1, and /api/health splits verdict-only noise_24h
-- from the swept_total count. Applied by deploy.sh after schema.sql; on
-- re-deploy SQLite errors on the duplicate ADD COLUMN and deploy.sh tolerates
-- that (keeps the rollout green).
ALTER TABLE signals ADD COLUMN swept INTEGER NOT NULL DEFAULT 0;
