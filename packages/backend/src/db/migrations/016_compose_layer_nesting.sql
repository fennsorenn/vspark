-- 016_compose_layer_nesting: Add parent_id for nested compose layers.

ALTER TABLE compose_layers ADD COLUMN parent_id TEXT REFERENCES compose_layers(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_compose_layers_parent_id ON compose_layers(parent_id);
