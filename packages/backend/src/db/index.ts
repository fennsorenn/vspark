import { dirname, join } from 'path';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { fileURLToPath } from 'url';
// esbuild handles CJS→ESM interop; this import gets bundled into bundle.cjs
import nodeSqliteWasm from 'node-sqlite3-wasm';
import type { Database as DatabaseType, Statement } from 'node-sqlite3-wasm';
import m001 from './migrations/001_initial.js';
import m002 from './migrations/002_node_components.js';
import m003 from './migrations/003_camera_effects.js';
import m004 from './migrations/004_bone_attachment.js';
import m005 from './migrations/005_node_hidden.js';
import m006 from './migrations/006_scene_runtime_settings.js';
import m007 from './migrations/007_scene_node_properties.js';
import m008 from './migrations/008_compose_layers.js';
import m009 from './migrations/009_track_clips.js';
import m010 from './migrations/010_track_clip_handle_fractions.js';
import m011 from './migrations/011_project_graphs.js';
import m012 from './migrations/012_overlive_app_credentials.js';
import m013 from './migrations/013_overlive_accounts.js';
import m014 from './migrations/014_graphs_table.js';
import m015 from './migrations/015_track_clips_owner_scope.js';
import m016 from './migrations/016_compose_layer_nesting.js';
import m017 from './migrations/017_presets_table.js';
import m018 from './migrations/018_refactor_scenes_to_nodes.js';
import m019 from './migrations/019_track_clips_owner_columns.js';
import m020 from './migrations/020_overlive_accounts_default.js';
import m021 from './migrations/021_track_clip_events.js';
import m022 from './migrations/022_rename_tables_to_vocab.js';
import m023 from './migrations/023_rename_behavior_context_kinds.js';
import m024 from './migrations/024_rename_preset_graphs_key.js';
import m025 from './migrations/025_rename_automations_table_to_logic.js';
import m026 from './migrations/026_rename_preset_logic_key.js';
import m027 from './migrations/027_multiplayer_identity.js';

const { Database } = nodeSqliteWasm as unknown as {
  Database: typeof DatabaseType;
};

const __dirname = dirname(fileURLToPath(import.meta.url));

// In dev (tsx): __dirname is src/db/ → DB lives at src/vspark.db (one level up)
// In bundle:    __dirname is the install dir containing bundle.cjs → DB lives there
const IS_BUNDLED = !__dirname.includes('/src/');
const DB_PATH = IS_BUNDLED
  ? join(__dirname, 'vspark.db')
  : join(__dirname, '..', 'vspark.db');

type Migration =
  | { name: string; sql: string }
  | { name: string; run: (db: WasmDb) => void };

const MIGRATIONS: Migration[] = [
  { name: '001_initial.sql', sql: m001 },
  { name: '002_node_components.sql', sql: m002 },
  { name: '003_camera_effects.sql', sql: m003 },
  { name: '004_bone_attachment.sql', sql: m004 },
  { name: '005_node_hidden.sql', sql: m005 },
  { name: '006_scene_runtime_settings.sql', sql: m006 },
  { name: '007_scene_node_properties.sql', sql: m007 },
  { name: '008_compose_layers.sql', sql: m008 },
  { name: '009_track_clips.sql', sql: m009 },
  { name: '010_track_clip_handle_fractions.sql', sql: m010 },
  { name: '011_project_graphs.sql', sql: m011 },
  { name: '012_overlive_app_credentials.sql', sql: m012 },
  { name: '013_overlive_accounts.sql', sql: m013 },
  { name: '014_graphs_table.sql', sql: m014 },
  { name: '015_track_clips_owner_scope.sql', sql: m015 },
  { name: '016_compose_layer_nesting.sql', sql: m016 },
  { name: '017_presets_table.sql', sql: m017 },
  { name: '018_refactor_scenes_to_nodes.sql', run: m018 },
  { name: '019_track_clips_owner_columns.sql', run: m019 },
  { name: '020_overlive_accounts_default.ts', run: m020 },
  { name: '021_track_clip_events.sql', sql: m021 },
  { name: '022_rename_tables_to_vocab.sql', sql: m022 },
  { name: '023_rename_behavior_context_kinds.ts', run: m023 },
  { name: '024_rename_preset_graphs_key.ts', run: m024 },
  { name: '025_rename_automations_table_to_logic.sql', sql: m025 },
  { name: '026_rename_preset_logic_key.ts', run: m026 },
  { name: '027_multiplayer_identity.sql', sql: m027 },
];

// Thin wrapper so call sites can use .run(a, b, c) spread syntax.
// node-sqlite3-wasm Statement.run() takes a single BindValues argument.
class PreparedStatement {
  constructor(private stmt: Statement) {}

  get(...params: unknown[]): Record<string, unknown> | undefined {
    const result =
      params.length === 0
        ? this.stmt.get()
        : this.stmt.get(params as import('node-sqlite3-wasm').JSValue[]);
    this.stmt.finalize();
    return result ?? undefined;
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    const result =
      params.length === 0
        ? this.stmt.all()
        : this.stmt.all(params as import('node-sqlite3-wasm').JSValue[]);
    this.stmt.finalize();
    return result as Record<string, unknown>[];
  }

  run(...params: unknown[]): void {
    if (params.length === 0) {
      this.stmt.run();
    } else {
      this.stmt.run(params as import('node-sqlite3-wasm').JSValue[]);
    }
    this.stmt.finalize();
  }
}

export class WasmDb {
  constructor(private db: DatabaseType) {}

  prepare(sql: string): PreparedStatement {
    return new PreparedStatement(this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

let _db: WasmDb | null = null;

export function getDb(): WasmDb {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return _db;
}

export async function initDb(): Promise<void> {
  if (_db) return;
  const db = new Database(DB_PATH);
  _db = new WasmDb(db);
}

export async function runMigrations(): Promise<void> {
  await initDb();
  const db = getDb();

  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    (
      db.prepare('SELECT name FROM _migrations').all() as { name: string }[]
    ).map((r) => r.name)
  );

  const pending = MIGRATIONS.filter((m) => !applied.has(m.name));
  if (pending.length > 0) {
    backupBeforeMigration(pending.map((m) => m.name));
  }

  for (const migration of pending) {
    try {
      if ('sql' in migration) {
        db.exec(migration.sql);
      } else {
        migration.run(db);
      }
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(
        migration.name
      );
    } catch (error) {
      console.error(`Failed to run migration ${migration.name}:`, error);
      throw error;
    }
  }
}

export function saveDb() {}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ─── Pre-migration backup ──────────────────────────────────────────────────

const MAX_BACKUPS = 5;

function backupBeforeMigration(pendingNames: string[]): void {
  if (!existsSync(DB_PATH)) return;

  const backupDir = join(dirname(DB_PATH), 'backups');
  mkdirSync(backupDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const label = pendingNames[0].replace(/\.sql$/, '');
  const backupPath = join(backupDir, `vspark-pre-${label}-${ts}.db`);
  copyFileSync(DB_PATH, backupPath);
  console.log(`[db] Backup created: ${backupPath}`);

  const files = readdirSync(backupDir)
    .filter((f) => f.startsWith('vspark-') && f.endsWith('.db'))
    .sort();
  while (files.length > MAX_BACKUPS) {
    const old = files.shift()!;
    try {
      unlinkSync(join(backupDir, old));
    } catch {
      /* best-effort */
    }
  }
}
