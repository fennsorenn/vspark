-- 002_node_components: Dedicated table for node components

CREATE TABLE IF NOT EXISTS node_components (
  id         TEXT PRIMARY KEY,
  node_id    TEXT NOT NULL REFERENCES scene_nodes(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  config     TEXT NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_node_components_node_id ON node_components(node_id);
