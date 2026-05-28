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

function tableExists(db: Db, table: string): boolean {
  const rows = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
    .all(table);
  return rows.length > 0;
}

function tableReferencesScenes(db: Db, table: string): boolean {
  const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
  return fks.some((fk) => fk.table === 'scenes');
}

// Rebuild a table from its stored CREATE SQL with the stale `scenes` FK removed.
// After 018 drops the scenes table, any column that still carries
// `REFERENCES scenes(id)` makes every FK check on that table fail with
// "no such table: main.scenes" — including cascades from a project delete.
// `selfRefColumn`, when set, is re-pointed at this table's own id instead of
// just having its FK stripped.
function rebuildWithoutScenesFk(
  db: Db,
  table: string,
  selfRefColumn?: string
): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
    .all(table)[0] as { sql: string } | undefined;
  if (!row?.sql) return;

  let sql = row.sql;
  if (selfRefColumn) {
    // Re-point the column's FK at this table instead of scenes.
    sql = sql.replace(
      new RegExp(
        `(\\b${selfRefColumn}\\b[^,]*?)REFERENCES\\s+scenes\\s*\\(\\s*id\\s*\\)(\\s+ON\\s+DELETE\\s+\\w+)?`,
        'i'
      ),
      `$1REFERENCES ${table}(id)`
    );
  } else {
    // Drop the FK clause entirely, leaving the plain column.
    sql = sql.replace(
      /\s*REFERENCES\s+scenes\s*\(\s*id\s*\)(\s+ON\s+DELETE\s+\w+)?/i,
      ''
    );
  }

  const tmp = `${table}__rebuild`;
  sql = sql.replace(
    new RegExp(`CREATE TABLE\\s+"?${table}"?`, 'i'),
    `CREATE TABLE ${tmp}`
  );

  const colRows = db.prepare(`PRAGMA table_info(${table})`).all();
  const cols = colRows.map((c) => c.name as string).join(', ');

  db.exec(sql);
  db.exec(`INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
}

export default function migrate(db: Db): void {
  // node-sqlite3-wasm enables foreign_keys by default. We must disable it for
  // this migration because DROP TABLE scenes would cascade-delete all scene_nodes
  // rows that still carry the (renamed) FK to scenes(id).
  db.exec(`PRAGMA foreign_keys = OFF`);

  const scenesExist = tableExists(db, 'scenes');
  const hasSceneId = hasColumn(db, 'scene_nodes', 'scene_id');

  // Step 1: Add project_id to scene_nodes if missing, backfill from scenes
  if (!hasColumn(db, 'scene_nodes', 'project_id')) {
    db.exec(
      `ALTER TABLE scene_nodes ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE`
    );
    if (scenesExist && hasSceneId) {
      db.exec(
        `UPDATE scene_nodes SET project_id = (SELECT project_id FROM scenes WHERE scenes.id = scene_nodes.scene_id)`
      );
    }
  }

  // Step 2: Insert kind='scene' root nodes for each existing scene.
  // The column used for the self-reference depends on whether step 3 already ran.
  if (scenesExist) {
    const fkCol = hasSceneId ? 'scene_id' : 'root_scene_node_id';
    db.exec(`INSERT OR IGNORE INTO scene_nodes (id, ${fkCol}, project_id, parent_id, name, kind, file_path, components, properties, hidden)
SELECT s.id, s.id, s.project_id, NULL, s.name, 'scene', NULL, '{}',
       COALESCE(s.runtime_settings, '{}'), 0
FROM scenes s`);
  }

  // Step 3: Rename scene_id → root_scene_node_id on scene_nodes
  if (hasSceneId) {
    db.exec(
      `ALTER TABLE scene_nodes RENAME COLUMN scene_id TO root_scene_node_id`
    );
  }

  // Step 4: Add project_id to compose_layers if missing
  const composeHasSceneId = hasColumn(db, 'compose_layers', 'scene_id');
  if (!hasColumn(db, 'compose_layers', 'project_id')) {
    db.exec(
      `ALTER TABLE compose_layers ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE`
    );
    if (composeHasSceneId) {
      // scene_id on compose_layers points to what is now a scene_node id
      db.exec(`UPDATE compose_layers SET project_id = (
  SELECT sn.project_id FROM scene_nodes sn WHERE sn.id = compose_layers.scene_id
)`);
    }
  }

  // Step 5: Add root_compose_scene_id to compose_layers if missing
  if (!hasColumn(db, 'compose_layers', 'root_compose_scene_id')) {
    db.exec(
      `ALTER TABLE compose_layers ADD COLUMN root_compose_scene_id TEXT REFERENCES compose_layers(id) ON DELETE CASCADE`
    );
  }

  // Step 6: Create compose_scene containers and wire up layers (only if scene_id still exists)
  if (composeHasSceneId) {
    db.exec(`INSERT OR IGNORE INTO compose_layers (id, scene_id, project_id, root_compose_scene_id, camera_node_id, parent_id, name, kind, config,
  x, y, width, height, rotation, anchor_h, anchor_v, scene_order, camera_order, visible)
SELECT
  scene_id || '_compose',
  scene_id,
  project_id,
  NULL,
  NULL,
  NULL,
  COALESCE((SELECT name FROM scene_nodes WHERE id = compose_layers.scene_id AND kind = 'scene'), 'Scene') || ' Compose',
  'compose_scene',
  '{}',
  0, 0, 1920, 1080, 0, 'left', 'top', 0, 0, 1
FROM compose_layers
GROUP BY scene_id`);

    db.exec(`UPDATE compose_layers SET root_compose_scene_id = scene_id || '_compose'
WHERE kind != 'compose_scene' AND root_compose_scene_id IS NULL`);

    db.exec(
      `UPDATE compose_layers SET root_compose_scene_id = NULL WHERE kind = 'compose_scene'`
    );

    db.exec(`DROP INDEX IF EXISTS idx_compose_layers_scene_id`);
    db.exec(`ALTER TABLE compose_layers DROP COLUMN scene_id`);
  }

  // Step 7: Rename scene_id → root_scene_node_id on track_clips
  if (hasColumn(db, 'track_clips', 'scene_id')) {
    db.exec(
      `ALTER TABLE track_clips RENAME COLUMN scene_id TO root_scene_node_id`
    );
  }

  // Step 8: Drop scenes table ONLY if scene data was successfully migrated.
  // Verify that every scene row has a corresponding kind='scene' node.
  if (scenesExist) {
    const orphaned = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM scenes s WHERE NOT EXISTS (
          SELECT 1 FROM scene_nodes sn WHERE sn.id = s.id AND sn.kind = 'scene'
        )`
      )
      .all();
    const orphanCount = (orphaned[0]?.cnt as number) ?? 0;
    if (orphanCount > 0) {
      throw new Error(
        `Migration 018: ${orphanCount} scene(s) were not migrated to scene_nodes. Aborting to prevent data loss.`
      );
    }
    db.exec(`DROP TABLE scenes`);
  }

  // Step 8b: Strip the now-dangling FK to scenes from every table that still
  // carries one. Indexes are dropped by the table rebuild and recreated in Step 9.
  if (!tableExists(db, 'scenes')) {
    if (tableReferencesScenes(db, 'scene_nodes')) {
      rebuildWithoutScenesFk(db, 'scene_nodes', 'root_scene_node_id');
    }
    if (tableReferencesScenes(db, 'track_clips')) {
      rebuildWithoutScenesFk(db, 'track_clips');
    }
    if (tableExists(db, 'sessions') && tableReferencesScenes(db, 'sessions')) {
      rebuildWithoutScenesFk(db, 'sessions');
    }
  }

  // Step 9: Update indexes
  db.exec(`DROP INDEX IF EXISTS idx_scenes_project_id`);
  db.exec(`DROP INDEX IF EXISTS idx_scene_nodes_scene_id`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_scene_nodes_project_id ON scene_nodes(project_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_scene_nodes_root_scene ON scene_nodes(root_scene_node_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_compose_layers_project_id ON compose_layers(project_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_compose_layers_root_compose ON compose_layers(root_compose_scene_id)`
  );
  db.exec(`DROP INDEX IF EXISTS idx_track_clips_scene_id`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_track_clips_root_scene ON track_clips(root_scene_node_id)`
  );

  db.exec(`PRAGMA foreign_keys = ON`);
}
