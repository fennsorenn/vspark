import { createRequire } from 'module';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Database as DatabaseType, Statement } from 'node-sqlite3-wasm';

const require = createRequire(import.meta.url);
// node-sqlite3-wasm is CJS-only; use createRequire to load it from ESM
const { Database } = require('node-sqlite3-wasm') as { Database: typeof DatabaseType };

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'vspark.db');
const MIGRATIONS_DIR = join(__dirname, 'migrations');

// Thin wrapper so call sites can use .run(a, b, c) spread syntax.
// node-sqlite3-wasm's Statement.run() takes a single BindValues argument,
// but the existing codebase spreads positional params.
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
  // node-sqlite3-wasm enables foreign_keys by default.
  // WAL mode omitted: node-sqlite3-wasm's VFS creates journal files next to the
  // db file; in some environments this fails if the path isn't writable for sidecars.
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

  const files = await readdir(MIGRATIONS_DIR).catch(() => [] as string[]);
  const migrationFiles = files.filter((f) => f.endsWith('.sql')).sort();

  for (const file of migrationFiles) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    } catch (error) {
      console.error(`Failed to run migration ${file}:`, error);
      throw error;
    }
  }
}

export function saveDb() {}

export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
}
