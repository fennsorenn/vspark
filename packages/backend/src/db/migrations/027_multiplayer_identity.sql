-- 027_multiplayer_identity: foundation for cross-server multiplayer (Phase 5).
-- See dev-notes/plans/multiplayer-phase5.md.

-- This server's stable identity. A single row (id = 1). The Ed25519 private key
-- never leaves the server; the public key (peer id) is what peers store.
CREATE TABLE IF NOT EXISTS server_identity (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  peer_id     TEXT NOT NULL,            -- public-key fingerprint (the stable peer id)
  public_key  TEXT NOT NULL,            -- base64 raw Ed25519 public key
  private_key TEXT NOT NULL,            -- base64 raw Ed25519 private key (local secret)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Paired contacts (the "previously connected people" list). Identity is by
-- peer_id (pubkey fingerprint), stable across the peer's IP changes.
CREATE TABLE IF NOT EXISTS known_peers (
  peer_id      TEXT PRIMARY KEY,        -- the peer's public-key fingerprint
  public_key   TEXT NOT NULL,           -- base64 raw Ed25519 public key (for the auth challenge)
  display_name TEXT NOT NULL DEFAULT '',
  paired_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen    TEXT,
  blocked      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Persisted accept policy: auto-accept this peer's incoming connections until
-- expiry. Persisted (not in-memory) so a crash/restart still reconnects without
-- a re-prompt mid-stream. Deleted on manual disconnect.
CREATE TABLE IF NOT EXISTS session_grants (
  peer_id    TEXT PRIMARY KEY REFERENCES known_peers(peer_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
