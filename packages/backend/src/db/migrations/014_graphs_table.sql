-- 014_graphs_table: Generalize project_graphs into a universal `graphs` table
-- with owner_kind/owner_id so graphs can be scoped to projects, scene nodes,
-- or compose layers. Existing project_graphs rows are migrated.

CREATE TABLE IF NOT EXISTS graphs (
  id          TEXT PRIMARY KEY,
  owner_kind  TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  descriptor  TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  node_state  TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO graphs (id, owner_kind, owner_id, name, enabled, descriptor, node_state, created_at, updated_at)
SELECT id, 'project', project_id, name, enabled, descriptor, node_state, created_at, updated_at
FROM project_graphs;

DROP TABLE IF EXISTS project_graphs;

CREATE INDEX IF NOT EXISTS idx_graphs_owner ON graphs(owner_kind, owner_id);
CREATE INDEX IF NOT EXISTS idx_graphs_enabled ON graphs(enabled) WHERE enabled = 1;
