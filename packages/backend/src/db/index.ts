import { dirname, join } from 'path';
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

const { Database } = nodeSqliteWasm as unknown as { Database: typeof DatabaseType };

const __dirname = dirname(fileURLToPath(import.meta.url));

// In dev (tsx): __dirname is src/db/ → DB lives at src/vspark.db (one level up)
// In bundle:    __dirname is the install dir containing bundle.cjs → DB lives there
const IS_BUNDLED = !__dirname.includes('/src/');
const DB_PATH = IS_BUNDLED
  ? join(__dirname, 'vspark.db')
  : join(__dirname, '..', 'vspark.db');

const MIGRATIONS = [
  { name: '001_initial.sql',       sql: m001 },
  { name: '002_node_components.sql', sql: m002 },
  { name: '003_camera_effects.sql',  sql: m003 },
  { name: '004_bone_attachment.sql', sql: m004 },
  { name: '005_node_hidden.sql',     sql: m005 },
  { name: '006_scene_runtime_settings.sql', sql: m006 },
  { name: '007_scene_node_properties.sql', sql: m007 },
];

// Thin wrapper so call sites can use .run(a, b, c) spread syntax.
// node-sqlite3-wasm Statement.run() takes a single BindValues argument.
class PreparedStatement {
  constructor(private stmt: Statement) {}

  get(...params: unknown[]): Record<string, unknown> | undefined {
    const result = params.length === 0
      ? this.stmt.get()
      : this.stmt.get(params as import('node-sqlite3-wasm').JSValue[]);
    this.stmt.finalize();
    return result ?? undefined;
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    const result = params.length === 0
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
    (db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name)
  );

  for (const { name, sql } of MIGRATIONS) {
    if (applied.has(name)) continue;
    try {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    } catch (error) {
      console.error(`Failed to run migration ${name}:`, error);
      throw error;
    }
  }
}

export function saveDb() {}

export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
}
