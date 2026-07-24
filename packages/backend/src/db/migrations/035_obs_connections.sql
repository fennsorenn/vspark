-- 035_obs_connections: per-project obs-websocket connection (the OBS "power
-- tier"). One row per project points the backend at an OBS instance's
-- obs-websocket server (default localhost:4455). This is opt-in: without a row,
-- only the zero-config browser-source bridge is active.
--
-- `password` is stored plaintext today, matching overlive_accounts; encryption-
-- at-rest is required project-wide before multi-user support.
--
-- `status` mirrors the same state vocabulary as overlive_accounts
-- ('connected', 'connecting', 'reconnecting', 'disconnected', 'error');
-- `status_reason` / `status_message` carry a short code + free text on error.

CREATE TABLE IF NOT EXISTS obs_connections (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label          TEXT NOT NULL DEFAULT 'OBS',
  host           TEXT NOT NULL DEFAULT 'localhost',
  port           INTEGER NOT NULL DEFAULT 4455,
  password       TEXT NOT NULL DEFAULT '',
  enabled        INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'disconnected',
  status_reason  TEXT,
  status_message TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_obs_connections_project_id ON obs_connections(project_id);
