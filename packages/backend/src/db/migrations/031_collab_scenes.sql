-- 031_collab_scenes: collaborative (peer-to-peer, persisted-on-both) scene
-- sharing. Distinct from object sharing's read-only ephemeral projection — here
-- the whole scene is a real, persisted, editable scene in EACH peer's project,
-- kept in sync last-write-wins. See dev-notes/plans/collaborative-scene-share.md.

-- One row per (scene, peer) collaboration link this server participates in.
--   role 'author'  = this server originally shared the scene.
--   role 'mounted' = this server received + persisted it.
-- The author wins reconnect-merge ties (live edits stay pure LWW).
CREATE TABLE IF NOT EXISTS collab_scenes (
  scene_id   TEXT NOT NULL,   -- shared scene_node id (identical on both peers)
  peer_id    TEXT NOT NULL,   -- the collaborating peer
  role       TEXT NOT NULL,   -- 'author' | 'mounted'
  project_id TEXT NOT NULL,   -- the local project the scene lives in
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scene_id, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_collab_scenes_scene ON collab_scenes(scene_id);

-- Tombstones: a deleted collab node, so a stale create from a peer on reconnect
-- can't resurrect it. `version` is the HLC of the delete (LWW tiebreak).
CREATE TABLE IF NOT EXISTS collab_tombstones (
  scene_id   TEXT NOT NULL,   -- collab scene the node belonged to
  node_id    TEXT NOT NULL,   -- deleted scene_node id
  version    TEXT NOT NULL,   -- HLC of the delete
  deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scene_id, node_id)
);
