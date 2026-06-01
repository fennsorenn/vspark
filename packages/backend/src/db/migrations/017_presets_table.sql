-- 017_presets_table: Per-project preset library for serialized node/layer subtrees.

CREATE TABLE IF NOT EXISTS presets (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  root_kind       TEXT NOT NULL,
  payload         TEXT NOT NULL,
  thumbnail_path  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_presets_project_id ON presets(project_id);
