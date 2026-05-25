-- 008_compose_layers: 2D overlay/underlay layers composited with the 3D scene render
-- See dev-notes for the ordering model. scene_order = 0 is the 3D render slot;
-- negative scene_order paints above the 3D, positive paints behind. Camera layers
-- carry a non-zero camera_order to interleave within a scene_order slot.

CREATE TABLE IF NOT EXISTS compose_layers (
  id              TEXT PRIMARY KEY,
  scene_id        TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  camera_node_id  TEXT REFERENCES scene_nodes(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  asset_id        TEXT REFERENCES asset_files(id) ON DELETE SET NULL,
  config          TEXT NOT NULL DEFAULT '{}',
  x               REAL NOT NULL DEFAULT 0,
  y               REAL NOT NULL DEFAULT 0,
  width           REAL NOT NULL DEFAULT 320,
  height          REAL NOT NULL DEFAULT 180,
  rotation        REAL NOT NULL DEFAULT 0,
  anchor_h        TEXT NOT NULL DEFAULT 'left',
  anchor_v        TEXT NOT NULL DEFAULT 'top',
  scene_order     INTEGER NOT NULL DEFAULT 0,
  camera_order    INTEGER NOT NULL DEFAULT 0,
  visible         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_compose_layers_scene_id   ON compose_layers(scene_id);
CREATE INDEX IF NOT EXISTS idx_compose_layers_camera_id  ON compose_layers(camera_node_id);
