/**
 * db.migrations.test.ts
 *
 * Tests for the DB migration runner (runMigrations / initDb / closeDb):
 *   (a) Running all migrations on a fresh :memory: DB creates the expected tables.
 *   (b) Re-running runMigrations is idempotent — no error is thrown and no rows
 *       are duplicated in _migrations.
 *   (c) The _migrations tracking table exists and records every migration.
 *
 * Note: the actual migration SQL is exercised through runMigrations itself.
 * We test the *runner* behaviour (idempotency, table creation) rather than
 * re-asserting every individual migration's SQL, which belongs in integration
 * coverage of the routes that use those tables.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrations, closeDb, getDb } from '../src/db/index.js';

// ── Reset between tests so each suite gets a clean :memory: DB ───────────────
beforeEach(async () => {
  process.env.VSPARK_DB_PATH = ':memory:';
  closeDb();
  await runMigrations();
});

afterEach(() => {
  closeDb();
});

// ─────────────────────────────────────────────────────────────────────────────
// Core tables created by migrations 001 – 033
// ─────────────────────────────────────────────────────────────────────────────

describe('Migration runner — expected tables', () => {
  /**
   * Returns the set of table names present in the in-memory DB.
   * Uses sqlite_master so we only rely on the DB itself.
   */
  function getTables(): Set<string> {
    const rows = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
  }

  it('creates the _migrations tracking table', () => {
    const tables = getTables();
    expect(tables.has('_migrations')).toBe(true);
  });

  it('creates the projects table', () => {
    expect(getTables().has('projects')).toBe(true);
  });

  it('creates the scene_nodes table (after migration 018 drops the scenes table)', () => {
    const tables = getTables();
    // After migration 018 the standalone scenes table is dropped and scene data
    // moves into scene_nodes with kind='scene'.
    expect(tables.has('scene_nodes')).toBe(true);
    expect(tables.has('scenes')).toBe(false);
  });

  it('creates the behaviors table (renamed from node_components in migration 022)', () => {
    const tables = getTables();
    expect(tables.has('behaviors')).toBe(true);
    // The old name must not exist anymore.
    expect(tables.has('node_components')).toBe(false);
  });

  it('creates the animation_clips table', () => {
    expect(getTables().has('animation_clips')).toBe(true);
  });

  it('creates the asset_files table', () => {
    expect(getTables().has('asset_files')).toBe(true);
  });

  it('creates the compose_layers table', () => {
    expect(getTables().has('compose_layers')).toBe(true);
  });

  it('creates the track_clips table', () => {
    expect(getTables().has('track_clips')).toBe(true);
  });

  it('creates the logic table (renamed from automations via migration 025)', () => {
    const tables = getTables();
    expect(tables.has('logic')).toBe(true);
    expect(tables.has('automations')).toBe(false);
    expect(tables.has('graphs')).toBe(false);
  });

  it('creates the scheduled_animations table (migration 033)', () => {
    expect(getTables().has('scheduled_animations')).toBe(true);
  });

  it('creates the overlive_accounts table', () => {
    expect(getTables().has('overlive_accounts')).toBe(true);
  });

  it('creates the mesh_tombstones table (migration 032)', () => {
    expect(getTables().has('mesh_tombstones')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// behaviors table schema (key columns used by manager persist paths)
// ─────────────────────────────────────────────────────────────────────────────

describe('Migration runner — behaviors table schema', () => {
  function getBehaviorColumns(): string[] {
    const rows = getDb()
      .prepare('PRAGMA table_info(behaviors)')
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  it('behaviors table has id, node_id, kind, enabled, config columns', () => {
    const cols = getBehaviorColumns();
    expect(cols).toContain('id');
    expect(cols).toContain('node_id');
    expect(cols).toContain('kind');
    expect(cols).toContain('enabled');
    expect(cols).toContain('config');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// animation_clips table schema
// ─────────────────────────────────────────────────────────────────────────────

describe('Migration runner — animation_clips table schema', () => {
  function getAnimClipColumns(): string[] {
    const rows = getDb()
      .prepare('PRAGMA table_info(animation_clips)')
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  it('animation_clips has id, name, source_node_id, source_file_path, duration', () => {
    const cols = getAnimClipColumns();
    expect(cols).toContain('id');
    expect(cols).toContain('name');
    expect(cols).toContain('source_node_id');
    expect(cols).toContain('source_file_path');
    expect(cols).toContain('duration');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency — running migrations twice is safe
// ─────────────────────────────────────────────────────────────────────────────

describe('Migration runner — idempotency', () => {
  it('calling runMigrations() a second time does not throw', async () => {
    // First run already applied in beforeEach.
    await expect(runMigrations()).resolves.not.toThrow();
  });

  it('_migrations rows are not duplicated on a second run', async () => {
    const countBefore = (
      getDb()
        .prepare('SELECT COUNT(*) AS cnt FROM _migrations')
        .all() as { cnt: number }[]
    )[0].cnt;

    await runMigrations();

    const countAfter = (
      getDb()
        .prepare('SELECT COUNT(*) AS cnt FROM _migrations')
        .all() as { cnt: number }[]
    )[0].cnt;

    expect(countAfter).toBe(countBefore);
  });

  it('all 35 migrations are recorded in _migrations after a full run', () => {
    const count = (
      getDb()
        .prepare('SELECT COUNT(*) AS cnt FROM _migrations')
        .all() as { cnt: number }[]
    )[0].cnt;
    // There are 35 migrations (001 – 035).
    expect(count).toBe(35);
  });

  it('each migration name appears exactly once in _migrations', () => {
    const rows = getDb()
      .prepare(
        'SELECT name, COUNT(*) AS cnt FROM _migrations GROUP BY name HAVING cnt > 1'
      )
      .all() as { name: string; cnt: number }[];
    expect(rows).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Basic DML works after migrations (smoke-test that FK constraints are live)
// ─────────────────────────────────────────────────────────────────────────────

describe('Migration runner — basic DML after migrations', () => {
  it('can INSERT into projects and SELECT it back', () => {
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Test')").run();
    const row = db
      .prepare('SELECT id, name FROM projects WHERE id = ?')
      .get('p1') as { id: string; name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe('Test');
  });

  it('can INSERT into behaviors and SELECT it back', () => {
    const db = getDb();
    // behaviors.node_id must reference scene_nodes.id — insert a scene_node first.
    db.prepare("INSERT INTO projects (id, name) VALUES ('p2', 'P')").run();
    db.prepare(
      "INSERT INTO scene_nodes (id, project_id, root_scene_node_id, name, kind, components) VALUES ('sn2', 'p2', 'sn2', 'Scene', 'scene', '{}')"
    ).run();
    db.prepare(
      "INSERT INTO behaviors (id, node_id, kind, enabled, config) VALUES ('b2', 'sn2', 'breathing', 1, '{}')"
    ).run();
    const row = db
      .prepare('SELECT id, kind FROM behaviors WHERE id = ?')
      .get('b2') as { id: string; kind: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.kind).toBe('breathing');
  });

  it('can INSERT into animation_clips and SELECT it back', () => {
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name) VALUES ('p3', 'P')").run();
    db.prepare(
      "INSERT INTO scene_nodes (id, project_id, root_scene_node_id, name, kind, components) VALUES ('sn3', 'p3', 'sn3', 'Scene', 'scene', '{}')"
    ).run();
    db.prepare(
      `INSERT INTO animation_clips (id, name, source_node_id, source_file_path, clip_index, label, start_time, end_time, duration, fps)
       VALUES ('ac3', 'Idle', 'sn3', '/uploads/test.fbx', 0, 'Idle', 0, 5, 5, 30)`
    ).run();
    const row = db
      .prepare('SELECT id, name, duration FROM animation_clips WHERE id = ?')
      .get('ac3') as
      | { id: string; name: string; duration: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe('Idle');
    expect(row!.duration).toBe(5);
  });
});
