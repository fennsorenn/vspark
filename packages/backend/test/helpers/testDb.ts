/**
 * Lightweight in-memory DB setup for tests that need the DB but not the
 * full Express app. Suitable for testing pure data-access modules
 * (multiplayer/peers, multiplayer/shares, multiplayer/collabScene, etc.)
 * where the app wiring is irrelevant.
 *
 * Usage:
 *   beforeEach(async () => { await resetDb(); });
 */
export async function resetDb(): Promise<void> {
  process.env.VSPARK_DB_PATH = ':memory:';
  const { closeDb, runMigrations } = await import('../../src/db/index.js');
  closeDb();
  await runMigrations();
}
