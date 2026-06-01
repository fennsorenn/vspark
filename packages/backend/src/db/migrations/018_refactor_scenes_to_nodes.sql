-- 018_refactor_scenes_to_nodes: Convert scenes into special scene_nodes (kind='scene'),
-- make compose_layers project-scoped with compose_scene containers, drop the scenes table.
--
-- This is a destructive migration. The scenes table is dropped entirely.
-- Scene IDs are reused as scene_node IDs so existing FKs remain valid.

-- Step 1: Add project_id to scene_nodes, backfill from scenes join
ALTER TABLE scene_nodes ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
UPDATE scene_nodes SET project_id = (SELECT project_id FROM scenes WHERE scenes.id = scene_nodes.scene_id);

-- Step 2: Insert kind='scene' node rows for each existing scene (reuse scene id as node id).
-- These become the root scene nodes. They must be inserted BEFORE renaming scene_id,
-- because scene_id still references the scenes table at this point.
INSERT OR IGNORE INTO scene_nodes (id, scene_id, project_id, parent_id, name, kind, file_path, components, properties, hidden)
SELECT s.id, s.id, s.project_id, NULL, s.name, 'scene', NULL, '{}',
       COALESCE(s.runtime_settings, '{}'), 0
FROM scenes s;

-- Step 3: Rename scene_id → root_scene_node_id on scene_nodes.
-- At this point all scene_id values are valid scene_node IDs (we just inserted them).
ALTER TABLE scene_nodes RENAME COLUMN scene_id TO root_scene_node_id;

-- Step 4: Add project_id and root_compose_scene_id to compose_layers
ALTER TABLE compose_layers ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
UPDATE compose_layers SET project_id = (
  SELECT sn.project_id FROM scene_nodes sn WHERE sn.id = compose_layers.scene_id
);
ALTER TABLE compose_layers ADD COLUMN root_compose_scene_id TEXT REFERENCES compose_layers(id) ON DELETE CASCADE;

-- Step 5: Create one compose_scene per existing scene.
-- Use scene_id || '_compose' as the compose_scene id to avoid collision with existing layer IDs.
INSERT INTO compose_layers (id, scene_id, project_id, root_compose_scene_id, camera_node_id, parent_id, name, kind, config,
  x, y, width, height, rotation, anchor_h, anchor_v, scene_order, camera_order, visible)
SELECT
  scene_id || '_compose',
  scene_id,
  project_id,
  NULL,
  NULL,
  NULL,
  (SELECT name FROM scene_nodes WHERE id = compose_layers.scene_id AND kind = 'scene') || ' Compose',
  'compose_scene',
  '{}',
  0, 0, 1920, 1080, 0, 'left', 'top', 0, 0, 1
FROM compose_layers
GROUP BY scene_id;

-- Step 6: Set root_compose_scene_id on existing layers
UPDATE compose_layers SET root_compose_scene_id = scene_id || '_compose'
WHERE kind != 'compose_scene' AND root_compose_scene_id IS NULL;

-- Also set root_compose_scene_id = NULL for compose_scene rows themselves (they ARE the root)
UPDATE compose_layers SET root_compose_scene_id = NULL WHERE kind = 'compose_scene';

-- Step 7: Drop scene_id from compose_layers
ALTER TABLE compose_layers DROP COLUMN scene_id;

-- Step 8: Rename scene_id → root_scene_node_id on track_clips
ALTER TABLE track_clips RENAME COLUMN scene_id TO root_scene_node_id;

-- Step 9: Drop the scenes table
DROP TABLE IF EXISTS scenes;

-- Step 10: Update indexes
DROP INDEX IF EXISTS idx_scenes_project_id;
DROP INDEX IF EXISTS idx_scene_nodes_scene_id;
CREATE INDEX IF NOT EXISTS idx_scene_nodes_project_id ON scene_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_scene_nodes_root_scene ON scene_nodes(root_scene_node_id);
CREATE INDEX IF NOT EXISTS idx_compose_layers_project_id ON compose_layers(project_id);
CREATE INDEX IF NOT EXISTS idx_compose_layers_root_compose ON compose_layers(root_compose_scene_id);
DROP INDEX IF EXISTS idx_track_clips_scene_id;
CREATE INDEX IF NOT EXISTS idx_track_clips_root_scene ON track_clips(root_scene_node_id);
