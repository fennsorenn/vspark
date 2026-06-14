-- 030_grants: generalized permission grants for the synced-state layer.
-- Supersedes `shares` (object-only, read-only): a grant is (grantee) ×
-- (entity selector: rtype+id, optionally its subtree) × (path prefix) × rights
-- (read/update/create/delete). The owning server self-grants full rights on its
-- own namespaces; enforcement is source-side admission. `shares` is kept until
-- the object-share path is migrated onto this. See
-- dev-notes/plans/permissioned-sync-mesh.md.
CREATE TABLE IF NOT EXISTS grants (
  id                  TEXT PRIMARY KEY,
  grantee             TEXT NOT NULL,            -- peer id (server or participant) or '*'
  entity_rtype        TEXT NOT NULL,            -- e.g. 'scene_node', or '*'
  entity_id           TEXT NOT NULL,            -- entity id, or '*'
  include_descendants INTEGER NOT NULL DEFAULT 0,
  path_prefix         TEXT NOT NULL DEFAULT '', -- '' = all paths
  can_read            INTEGER NOT NULL DEFAULT 0,
  can_update          INTEGER NOT NULL DEFAULT 0,
  can_create          INTEGER NOT NULL DEFAULT 0,
  can_delete          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (grantee, entity_rtype, entity_id, include_descendants, path_prefix)
);
CREATE INDEX IF NOT EXISTS idx_grants_grantee ON grants(grantee);
