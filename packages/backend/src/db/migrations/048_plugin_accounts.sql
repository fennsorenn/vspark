-- 048_plugin_accounts: accounts of plugin account providers (plugin-system
-- phase 3; dev-notes/modules/plugins.md#accounts).
--
-- plugin_accounts: one logged-in identity of a provider (`<pluginId>:<id>`)
-- in a project — per project, like overlive_accounts (decided: user,
-- 2026-11-26). The row is the persisted form of a `plugin_account` mesh
-- document EXCEPT `credentials` (tokens), which never leaves the server: the
-- resource's load does not read it and its save does not write it.
--
-- plugin_apps: a provider's app credentials per project (e.g. a Spotify app's
-- client id, entered once). Id `<projectId>:<provider>`. Persisted form of a
-- `plugin_app` mesh document. Only non-secret fields (PKCE needs none).

CREATE TABLE IF NOT EXISTS plugin_accounts (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  identity    TEXT NOT NULL DEFAULT '{}',
  credentials TEXT NOT NULL DEFAULT '{}',
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plugin_accounts_project ON plugin_accounts(project_id, provider);

CREATE TABLE IF NOT EXISTS plugin_apps (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  fields     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, provider)
);
