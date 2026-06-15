import type { Express } from 'express';

/**
 * Build an Express app backed by a fresh in-memory SQLite DB with all
 * migrations applied. Each call resets the DB, so tests are isolated.
 *
 * `VSPARK_DB_PATH=':memory:'` must be set before the db module is first
 * imported — node-sqlite3-wasm reads the path at module load — so the db and
 * app modules are imported dynamically here, after the env var is in place.
 */
export async function makeTestApp(): Promise<{ app: Express }> {
  process.env.VSPARK_DB_PATH = ':memory:';

  const { runMigrations, closeDb } = await import('../../src/db/index.js');
  const { createApp } = await import('../../src/app.js');

  // Reset any DB from a previous test in this worker, then migrate a clean one.
  closeDb();
  await runMigrations();

  return { app: createApp() };
}
