-- 008_compose_layers: 2D overlay/underlay layers composited with the 3D scene render
--
-- HISTORICAL — the ordering model described here is DEAD, and the columns that
-- carried it no longer exist. As of this migration the model was signed:
-- scene_order = 0 was the 3D render slot, negative painted above the 3D,
-- positive behind, and camera_order interleaved camera layers within a slot.
-- Migration 036 dropped both columns for a single string fractional order_key
-- (packages/shared/src/fracIndex.ts), sorted (order_key, id) ascending =
-- back->front, per sibling set. Do not read the columns below as current
-- behaviour; see 036 for the live model.

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
