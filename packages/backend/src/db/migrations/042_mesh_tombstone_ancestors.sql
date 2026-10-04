-- 042_mesh_tombstone_ancestors: where a deleted entity sat in the tree.
--
-- A tombstone is sent only to subscribers whose grants cover the deleted
-- entity (principle 9: nothing is sent to a participant it may not read). For
-- grants scoped to a subtree that means knowing the entity's ancestors, which
-- the containment index forgets the moment the entity is removed. The mesh
-- keeps the chain in memory; this column keeps it across a restart, so a
-- subtree-scoped collab peer still learns about deletions made before it.
--
-- JSON array of ancestor ids, nearest first. NULL for rows written before
-- this migration: those tombstones reach only rtype-wide grants.

ALTER TABLE mesh_tombstones ADD COLUMN ancestors TEXT;
