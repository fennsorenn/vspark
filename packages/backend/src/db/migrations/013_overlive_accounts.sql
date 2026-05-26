-- 013_overlive_accounts: per-project login accounts authenticated via overlive.
-- Twitch accounts hold OAuth access + refresh tokens and reference the
-- `app_credential_id` they were created against. StreamElements accounts
-- hold a JWT and leave `app_credential_id` NULL (SE has no per-developer
-- app layer).
--
-- `credentials` is a JSON blob whose shape depends on platform:
--   twitch:         { accessToken, refreshToken, scopes[], expiresAt? }
--   streamelements: { jwt, channelId }
--
-- `status` reflects the last known connection state surfaced from
-- OverliveKit ('connected', 'connecting', 'disconnected', 'error',
-- 'needs_reauth'); `status_reason` carries the AdapterStateReason
-- (token_revoked, scope_missing, etc.) when state is error/needs_reauth.
--
-- Stored credentials are plaintext today; encryption-at-rest required
-- before multi-user support lands.

CREATE TABLE IF NOT EXISTS overlive_accounts (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  platform            TEXT NOT NULL,                  -- 'twitch' | 'streamelements'
  label               TEXT NOT NULL,
  app_credential_id   TEXT REFERENCES overlive_app_credentials(id) ON DELETE SET NULL,
  credentials         TEXT NOT NULL DEFAULT '{}',
  broadcaster_id      TEXT,                           -- twitch user_id / SE channel id
  broadcaster_login   TEXT,                           -- twitch login (human-readable) / NULL for SE
  status              TEXT NOT NULL DEFAULT 'disconnected',
  status_reason       TEXT,
  status_message      TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_overlive_accounts_project_id ON overlive_accounts(project_id);
CREATE INDEX IF NOT EXISTS idx_overlive_accounts_platform   ON overlive_accounts(project_id, platform);
