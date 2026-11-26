-- 045_actions: Actions — preauthored, project-level workflows configured by a
-- settings form (plan: dev-notes/plans/actions.md, module: dev-notes/modules/actions.md).
--
-- Each action OWNS exactly one Logic graph: a `logic` row with
-- owner_kind = 'action' and owner_id = actions.id. The coupling is ownership,
-- not columns on `logic` (plain Logic rows carry no action fields); deleting an
-- action deletes its graph through the mesh (logic is parented to the action).
--
-- `settings` is the kind's settings JSON. `template_fingerprint` is the
-- fingerprint of the template output the graph was last generated from
-- (positions excluded; see @vspark/shared/actions graphFingerprint) — the graph
-- reads as "modified" when its own fingerprint differs, and "template update
-- available" when the template now produces something else.

CREATE TABLE IF NOT EXISTS actions (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL,
  name                 TEXT NOT NULL,
  enabled              INTEGER NOT NULL DEFAULT 1,
  settings             TEXT NOT NULL DEFAULT '{}',
  template_fingerprint TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_actions_project_id ON actions(project_id);
