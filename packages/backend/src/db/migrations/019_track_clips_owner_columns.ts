// 019_track_clips_owner_columns: replace the polymorphic owner_kind/owner_id +
// root_scene_node_id columns on track_clips with two nullable owner columns —
// owner_node_id (a scene_node) and owner_layer_id (a compose_layer) — where
// exactly one is set per clip.
//
// Scenes are themselves scene_nodes now, so legacy clips that were owner_kind
// ='scene' migrate to owner_node_id = their scene node id. owner_kind
// ='scene_node' → owner_node_id; owner_kind='compose_layer' → owner_layer_id.
//
// FKs are toggled OFF for the rebuild (node-sqlite3-wasm enables them by
// default, unlike stock SQLite) so dropping the old table doesn't cascade.

interface Db {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): void;
  };
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

export default function migrate(db: Db): void {
  const hasNewOwners =
    hasColumn(db, 'track_clips', 'owner_node_id') &&
    hasColumn(db, 'track_clips', 'owner_layer_id');

  // Idempotency: fully-migrated tables (new owner cols AND started_at) are
  // left alone. A DB that has the new owner cols but is missing started_at ran
  // an in-progress version of this migration; fall through to rebuild it.
  if (hasNewOwners && hasColumn(db, 'track_clips', 'started_at')) {
    return;
  }

  db.exec('PRAGMA foreign_keys = OFF');

  db.exec(`
    CREATE TABLE track_clips__new (
      id            TEXT PRIMARY KEY,
      owner_node_id  TEXT REFERENCES scene_nodes(id) ON DELETE CASCADE,
      owner_layer_id TEXT REFERENCES compose_layers(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      duration      REAL NOT NULL DEFAULT 2,
      loop          INTEGER NOT NULL DEFAULT 0,
      mode          TEXT NOT NULL DEFAULT 'override',
      autoplay      INTEGER NOT NULL DEFAULT 0,
      started_at    INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (
        (owner_node_id IS NOT NULL AND owner_layer_id IS NULL) OR
        (owner_node_id IS NULL AND owner_layer_id IS NOT NULL)
      )
    )
  `);

  // Migrate rows. owner_kind decides which column the existing owner_id (or
  // legacy scene root) maps to.
  //  - compose_layer → owner_layer_id
  //  - scene_node    → owner_node_id (owner_id is the node)
  //  - scene/other   → owner_node_id (the scene IS a scene_node; prefer
  //                    root_scene_node_id which always held that scene id)
  const hasOwnerKind = hasColumn(db, 'track_clips', 'owner_kind');
  const hasRoot = hasColumn(db, 'track_clips', 'root_scene_node_id');
  const hasStartedAt = hasColumn(db, 'track_clips', 'started_at');
  const startedAtSel = hasStartedAt ? 'started_at' : 'NULL';

  if (hasNewOwners) {
    // Already converted to owner_node_id/owner_layer_id but missing started_at
    // (in-progress migration). Carry the owner columns over verbatim.
    db.exec(`
      INSERT INTO track_clips__new
        (id, owner_node_id, owner_layer_id, name, duration, loop, mode, autoplay, started_at, created_at)
      SELECT
        id, owner_node_id, owner_layer_id,
        name, duration, loop, mode, autoplay, ${startedAtSel}, created_at
      FROM track_clips
    `);
  } else if (hasOwnerKind) {
    db.exec(`
      INSERT INTO track_clips__new
        (id, owner_node_id, owner_layer_id, name, duration, loop, mode, autoplay, started_at, created_at)
      SELECT
        id,
        CASE WHEN owner_kind = 'compose_layer' THEN NULL
             WHEN owner_kind = 'scene_node'    THEN owner_id
             ELSE ${hasRoot ? 'root_scene_node_id' : 'owner_id'}
        END,
        CASE WHEN owner_kind = 'compose_layer' THEN owner_id ELSE NULL END,
        name, duration, loop, mode, autoplay, ${startedAtSel}, created_at
      FROM track_clips
    `);
  } else {
    // Pre-015 schema (no owner columns at all): everything was scene-owned via
    // root_scene_node_id.
    db.exec(`
      INSERT INTO track_clips__new
        (id, owner_node_id, owner_layer_id, name, duration, loop, mode, autoplay, started_at, created_at)
      SELECT
        id, ${hasRoot ? 'root_scene_node_id' : 'NULL'}, NULL,
        name, duration, loop, mode, autoplay, ${startedAtSel}, created_at
      FROM track_clips
    `);
  }

  // Drop any row that couldn't satisfy the exactly-one CHECK would have failed
  // the INSERT above; node-sqlite3-wasm enforces CHECK, so orphans (owner_id
  // pointing nowhere) still insert but reference a missing parent — harmless
  // with FKs off; they'll be cascade-cleaned on the next owner delete.

  db.exec('DROP TABLE track_clips');
  db.exec('ALTER TABLE track_clips__new RENAME TO track_clips');

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_track_clips_owner_node ON track_clips(owner_node_id)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_track_clips_owner_layer ON track_clips(owner_layer_id)'
  );

  db.exec('PRAGMA foreign_keys = ON');
}
