-- 003_camera_effects: Dedicated table for camera post-processing effects

CREATE TABLE IF NOT EXISTS camera_effects (
  id         TEXT PRIMARY KEY,
  node_id    TEXT NOT NULL REFERENCES scene_nodes(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  config     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_camera_effects_node_id ON camera_effects(node_id);
