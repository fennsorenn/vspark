-- 011_project_graphs: standalone signal graphs owned by a project (not a node component).
-- Unlike component-owned graphs, project graphs are user-authored and writable in the
-- Graphs panel. They cannot use component-context nodes (component_config / component_id /
-- scene_entity) — those throw at runtime when executed inside a project graph.

CREATE TABLE IF NOT EXISTS project_graphs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  descriptor  TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  -- Per-node persisted state, keyed by node id. Mirrors the _nodeState convention
  -- the component-owned managers use, but stored on the graph row directly since
  -- there is no surrounding component config row.
  node_state  TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_project_graphs_project_id ON project_graphs(project_id);
CREATE INDEX IF NOT EXISTS idx_project_graphs_enabled    ON project_graphs(enabled) WHERE enabled = 1;
