import Database from 'better-sqlite3';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'vspark.db');
const MIGRATIONS_DIR = join(__dirname, 'migrations');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function initDb(): Database.Database {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export async function runMigrations() {
  const database = initDb();
  const files = await readdir(MIGRATIONS_DIR).catch(() => [] as string[]);
  const migrationFiles = files.filter((f) => f.endsWith('.sql')).sort();

  for (const file of migrationFiles) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
    try {
      database.exec(sql);
    } catch (error) {
      console.error(`Failed to run migration ${file}:`, error);
      throw error;
    }
  }
}

// No-op kept for API compatibility — better-sqlite3 writes to disk synchronously.
export function saveDb() {}

export function closeDb() {
  if (db) { db.close(); db = null; }
}
