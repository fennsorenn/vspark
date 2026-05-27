-- 012_overlive_app_credentials: per-project Twitch app (developer) credentials.
-- These represent the OAuth app the user registered at dev.twitch.tv —
-- distinct from the login accounts that authenticate through that app
-- (see migration 013). One project may hold multiple apps and multiple
-- login accounts; each login account references the app it was created
-- against. SE has no app concept, so SE login accounts will leave
-- `app_credential_id` NULL in migration 013.
--
-- Stored client_secret is plaintext today; encryption-at-rest is required
-- before multi-user support lands (see ARCHITECTURE.md → Future Features).

CREATE TABLE IF NOT EXISTS overlive_app_credentials (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  client_id     TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  redirect_uri  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_overlive_app_credentials_project_id
  ON overlive_app_credentials(project_id);
