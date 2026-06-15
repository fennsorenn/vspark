import type { Express } from 'express';

/**
 * Build an Express app backed by a fresh in-memory SQLite DB with all
 * migrations applied. Each call resets the DB, so tests are isolated.
 *
 * `VSPARK_DB_PATH=':memory:'` must be set before the db module is first
 * imported — node-sqlite3-wasm reads the path at module load — so the db and
 * app modules are imported dynamically here, after the env var is in place.
 *
 * Pass `{ mesh: true }` to also bootstrap the backend mesh store (no sockets):
 * REST routes that write through `getMeshCollection(...)` (scene-nodes,
 * behaviors, compose-layers, …) need it. The peer is reset per call so mesh
 * state doesn't leak across tests.
 */
export async function makeTestApp(
  opts: { mesh?: boolean } = {}
): Promise<{ app: Express }> {
  process.env.VSPARK_DB_PATH = ':memory:';

  const { runMigrations, closeDb } = await import('../../src/db/index.js');
  const { createApp } = await import('../../src/app.js');
  const { resetBackendMesh, initBackendMesh } = await import(
    '../../src/mesh/index.js'
  );

  // Tear down any prior peer, reset the DB, migrate a clean one.
  resetBackendMesh();
  closeDb();
  await runMigrations();
  if (opts.mesh) initBackendMesh();

  return { app: createApp() };
}
