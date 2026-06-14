-- 032_mesh_tombstones: generic per-entity deletion markers for the mesh store
-- (replaces the scene-scoped collab_tombstones for mesh-synced rtypes). A
-- durable peer persists every committed remove with its HLC stamp and
-- re-hydrates them at boot, so reconnect convergence can't resurrect an
-- entity deleted while a peer was offline. Pruned by age (resurrect window =
-- prune age). See dev-notes/plans/mesh-sync-refactor.md §8.7/§9.

CREATE TABLE IF NOT EXISTS mesh_tombstones (
  rtype      TEXT NOT NULL,
  id         TEXT NOT NULL,
  -- HLC stamp of the delete
  v_t        INTEGER NOT NULL,
  v_c        INTEGER NOT NULL,
  v_n        TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (rtype, id)
);
