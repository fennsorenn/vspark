-- 043_client_credentials: browsers allowed to join this server's mesh.
--
-- Principle 9: every participant authenticates, and an unauthenticated
-- connection is refused at the handshake. A browser enrolls once (automatically
-- on this machine, with a pairing code from anywhere else) and keeps a random
-- bearer token; only its SHA-256 is stored here. Revoking a row locks that
-- browser out at its next connection.

CREATE TABLE IF NOT EXISTS client_credentials (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT,
  revoked_at TEXT
);
