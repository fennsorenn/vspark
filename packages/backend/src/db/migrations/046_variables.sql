-- 046_variables: persistent signal-graph variables.
--
-- One row per (project, scope, name), written by the `set_variable` /
-- `increment_variable` nodes when their `persistent` input is true. The row is
-- the persisted form of a `variable` mesh document (sync/resources.ts); the
-- short-lived variables live in the `runtime_variable` collection and never
-- reach this table. `scope` is free text: '' is the shared namespace, a Logic
-- graph id makes the variable private to that graph (deleted with it).
-- `value` is JSON.
--
-- Numbered 046: 045 is reserved for the `actions` table on a parallel branch.

CREATE TABLE IF NOT EXISTS variables (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL,
  value      TEXT NOT NULL DEFAULT 'null',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, scope, name)
);

CREATE INDEX IF NOT EXISTS idx_variables_scope ON variables(scope);
