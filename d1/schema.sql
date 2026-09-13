-- AIMoney Lab schema (D1 / SQLite)
-- Opportunities: the priority list. Score is computed, never hand-set:
--   score = 100 * (value * confidence * fit) / (effort + 1), inputs 1-10.

CREATE TABLE IF NOT EXISTS opportunities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  one_liner     TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT 'other',
  status        TEXT NOT NULL DEFAULT 'backlog',
  value         INTEGER NOT NULL DEFAULT 5,
  effort        INTEGER NOT NULL DEFAULT 5,
  confidence    INTEGER NOT NULL DEFAULT 5,
  fit           INTEGER NOT NULL DEFAULT 5,
  score         REAL NOT NULL DEFAULT 0,
  est_monthly_low   INTEGER NOT NULL DEFAULT 0,
  est_monthly_high  INTEGER NOT NULL DEFAULT 0,
  time_to_first_dollar TEXT NOT NULL DEFAULT '',
  capital_needed TEXT NOT NULL DEFAULT '',
  skills_needed TEXT NOT NULL DEFAULT '[]',
  source        TEXT NOT NULL DEFAULT 'seed',
  source_url    TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_opp_status_score ON opportunities(status, score DESC);
CREATE INDEX IF NOT EXISTS idx_opp_category ON opportunities(category);

-- Research briefs: evidence behind each opportunity. Latest per opportunity wins.
CREATE TABLE IF NOT EXISTS briefs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id  INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL DEFAULT 1,
  summary         TEXT NOT NULL DEFAULT '',
  what_works      TEXT NOT NULL DEFAULT '',
  numbers_json    TEXT NOT NULL DEFAULT '[]',
  risks           TEXT NOT NULL DEFAULT '',
  first_steps     TEXT NOT NULL DEFAULT '',
  sources_json    TEXT NOT NULL DEFAULT '[]',
  author          TEXT NOT NULL DEFAULT 'seed',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_briefs_opp ON briefs(opportunity_id, version DESC);

-- Experiments: strategies under test. One row per attempt, post-mortem required.
CREATE TABLE IF NOT EXISTS experiments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id  INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  hypothesis      TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'planned',
  budget_cap      TEXT NOT NULL DEFAULT '',
  spent           TEXT NOT NULL DEFAULT '',
  metric          TEXT NOT NULL DEFAULT '',
  target          TEXT NOT NULL DEFAULT '',
  result          TEXT NOT NULL DEFAULT '',
  started_at      TEXT NOT NULL DEFAULT '',
  ended_at        TEXT NOT NULL DEFAULT '',
  post_mortem     TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_exp_opp ON experiments(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_exp_status ON experiments(status);

-- Raw signals the agents collected (deduped by source+external_id).
CREATE TABLE IF NOT EXISTS signals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  external_id   TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL,
  url           TEXT NOT NULL DEFAULT '',
  snippet       TEXT NOT NULL DEFAULT '',
  published_at  TEXT NOT NULL DEFAULT '',
  opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  processed     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_signals_unprocessed ON signals(processed, created_at);

-- Agent run log: every research pass, what it did, cost, errors.
CREATE TABLE IF NOT EXISTS agent_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent         TEXT NOT NULL,
  trigger       TEXT NOT NULL DEFAULT 'cron',
  started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  finished_at   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'running',
  signals_seen  INTEGER NOT NULL DEFAULT 0,
  added         INTEGER NOT NULL DEFAULT 0,
  updated       INTEGER NOT NULL DEFAULT 0,
  briefs        INTEGER NOT NULL DEFAULT 0,
  ai_calls      INTEGER NOT NULL DEFAULT 0,
  error         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON agent_runs(started_at DESC);
