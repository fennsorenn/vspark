import { dirname, join } from 'path';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
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
import m028 from './migrations/028_project_mp_display_name.js';
import m029 from './migrations/029_shares.js';
import m030 from './migrations/030_grants.js';
import m031 from './migrations/031_collab_scenes.js';
import m032 from './migrations/032_mesh_tombstones.js';
import m033 from './migrations/033_scheduled_animations.js';
import m034 from './migrations/034_asset_metadata.js';
import m035 from './migrations/035_tracking_grace_period_to_node.js';

const { Database } = nodeSqliteWasm as unknown as {
  Database: typeof DatabaseType;
};

const __dirname = dirname(fileURLToPath(import.meta.url));

// In dev (tsx): __dirname is src/db/ → DB lives at src/vspark.db (one level up)
// In bundle:    __dirname is the install dir containing bundle.cjs → DB lives there
const IS_BUNDLED = !__dirname.includes('/src/');
// VSPARK_DB_PATH override lets two instances use separate DBs on one box
// (multiplayer testing). Defaults to the install/src location.
const DB_PATH =
  process.env.VSPARK_DB_PATH ??
  (IS_BUNDLED
    ? join(__dirname, 'vspark.db')
    : join(__dirname, '..', 'vspark.db'));

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
  { name: '028_project_mp_display_name.sql', sql: m028 },
  { name: '029_shares.sql', sql: m029 },
  { name: '030_grants.sql', sql: m030 },
  { name: '031_collab_scenes.sql', sql: m031 },
  { name: '032_mesh_tombstones.sql', sql: m032 },
  { name: '033_scheduled_animations.sql', sql: m033 },
  { name: '034_asset_metadata.sql', sql: m034 },
  { name: '035_tracking_grace_period_to_node.ts', run: m035 },
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

// ─── Lock ownership (stale-lock reclaim) ────────────────────────────────────
//
// node-sqlite3-wasm has no OS file locks (WASM sandbox); it serialises via an
// atomically-created `<db>.lock/` directory, acquired/released *per operation*.
// So an idle backend holds no lock, and the DB open alone cannot distinguish
// "another backend owns this file" from "a crashed predecessor left debris".
// A crash strands the `.lock/` dir and/or the rollback journal (WAL does not
// stick in this build — PRAGMA journal_mode=WAL silently stays 'delete'), and
// every later open then fails with "database is locked".
//
// We therefore track the owner in a sidecar PID file and treat it as the
// authoritative live-holder gate (see initDb): a live holder is refused (never
// evicted), a dead/absent holder means we own the file — clear debris and open.
//
// In-memory DBs (:memory:, used by tests) are per-connection and never shared,
// so all of this is skipped for them.
const IS_MEMORY_DB = DB_PATH === ':memory:';
const PID_PATH = `${DB_PATH}.pid`;
const JOURNAL_PATH = `${DB_PATH}-journal`;
// node-sqlite3-wasm has no OS file locks (WASM sandbox), so it locks via an
// atomically-created `<db>.lock/` directory: mkdir to acquire, rmdir to
// release. A crash strands this dir and every subsequent open then fails with
// "database is locked" — this is the primary cause of the recurring lockups.
const LOCK_DIR = `${DB_PATH}.lock`;

// Signal 0 probes for existence without delivering a signal. ESRCH → no such
// process (stale). EPERM → alive but owned by another user (treat as alive).
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Returns true if the lock looks reclaimable: no PID file, an unparseable one,
// or one naming a dead process. A live, parseable holder returns false.
function lockHolderIsStale(): { stale: boolean; pid: number | null } {
  if (!existsSync(PID_PATH)) return { stale: true, pid: null };
  let pid: number;
  try {
    pid = parseInt(readFileSync(PID_PATH, 'utf8').trim(), 10);
  } catch {
    return { stale: true, pid: null };
  }
  if (!Number.isInteger(pid) || pid <= 0) return { stale: true, pid: null };
  if (pid === process.pid) return { stale: true, pid }; // our own re-open
  return { stale: !isProcessAlive(pid), pid };
}

function claimLock(): void {
  try {
    writeFileSync(PID_PATH, String(process.pid), 'utf8');
  } catch {
    /* best-effort: recovery still works off journal presence */
  }
}

function openDatabase(): DatabaseType {
  const db = new Database(DB_PATH);
  // Wait up to 5s for a transient holder (e.g. a watcher restart racing its
  // predecessor's shutdown) to release, rather than failing instantly.
  db.exec('PRAGMA busy_timeout = 5000;');
  // The constructor is lazy — SQLite acquires no lock until the first
  // read/write, so a locked DB would otherwise surface only later (inside
  // runMigrations). Force the lock to materialize here with a write probe so
  // the reclaim logic in initDb() can act on it. BEGIN IMMEDIATE takes the
  // reserved lock without writing anything; COMMIT releases it.
  try {
    db.exec('BEGIN IMMEDIATE; COMMIT;');
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function isLockedError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return /database is locked|SQLITE_BUSY/i.test(msg);
}

function reclaimStaleDebris(pid: number | null): void {
  console.warn(
    `[db] Reclaiming stale lock${pid ? ` from dead pid ${pid}` : ''} — ` +
      `removing stale lock dir + journal.`
  );
  try {
    if (existsSync(LOCK_DIR)) rmdirSync(LOCK_DIR);
  } catch {
    /* best-effort: dir should be empty (lock dirs hold no files) */
  }
  try {
    if (existsSync(JOURNAL_PATH)) unlinkSync(JOURNAL_PATH);
  } catch {
    /* best-effort */
  }
}

export async function initDb(): Promise<void> {
  if (_db) return;

  // In-memory DBs are per-connection: no file, no cross-process lock, no PID
  // bookkeeping. Open and return.
  if (IS_MEMORY_DB) {
    _db = new WasmDb(new Database(DB_PATH));
    return;
  }

  // node-sqlite3-wasm creates the DB file but not its parent dir; ensure it
  // exists so a custom VSPARK_DB_PATH (e.g. multiplayer test DBs) can open.
  mkdirSync(dirname(DB_PATH), { recursive: true });

  // The PID file is the authoritative live-holder gate. node-sqlite3-wasm's own
  // lock (the `.lock/` dir) is per-operation, not per-process — an idle backend
  // holds nothing, so the DB open alone can't tell "another backend owns this"
  // from "crash debris". We consult the PID file first:
  //   - live holder  → refuse (never evict a running peer).
  //   - dead/absent  → we're the legitimate owner; clear any debris and open.
  const { stale, pid } = lockHolderIsStale();
  if (!stale) {
    throw new Error(
      `[db] Database is in use by a running vspark backend (pid ${pid}). ` +
        `Stop it before starting another instance, or set VSPARK_DB_PATH / ` +
        `PORT to run a second instance against a separate DB.`
    );
  }
  // Clear any crash debris from a dead predecessor before opening. Harmless
  // when there's none (pristine start).
  if (existsSync(LOCK_DIR) || existsSync(JOURNAL_PATH)) {
    reclaimStaleDebris(pid);
  }

  let db: DatabaseType;
  try {
    db = openDatabase();
  } catch (err) {
    // Fallback for a genuine concurrent-write race that slipped past the PID
    // gate (e.g. a peer mid-transaction with no/stale PID file). busy_timeout
    // already waited; one debris-clear + retry, then give up.
    if (!isLockedError(err)) throw err;
    reclaimStaleDebris(pid);
    db = openDatabase();
  }

  claimLock();
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
  if (IS_MEMORY_DB) return;
  // Release our lock ownership so the next start sees no stale holder. Only
  // remove the PID file if it still names us — a reclaiming successor may have
  // already overwritten it.
  try {
    if (existsSync(PID_PATH)) {
      const owner = parseInt(readFileSync(PID_PATH, 'utf8').trim(), 10);
      if (owner === process.pid) unlinkSync(PID_PATH);
    }
  } catch {
    /* best-effort */
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
