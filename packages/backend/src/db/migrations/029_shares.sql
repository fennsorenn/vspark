-- 029_shares: owner-side ACL for object/scene sharing (Phase 5). Which peers may
-- subscribe to which of my objects. grantee_peer_id = '*' means "all contacts".
-- See dev-notes/plans/multiplayer-phase5.md.
CREATE TABLE IF NOT EXISTS shares (
  id              TEXT PRIMARY KEY,
  share_kind      TEXT NOT NULL,        -- 'object' (scene_node) | 'scene'
  object_id       TEXT NOT NULL,        -- scene_node id or scene id
  grantee_peer_id TEXT NOT NULL,        -- known_peers.peer_id or '*'
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (share_kind, object_id, grantee_peer_id)
);
CREATE INDEX IF NOT EXISTS idx_shares_grantee ON shares(grantee_peer_id);
CREATE INDEX IF NOT EXISTS idx_shares_object ON shares(object_id);
