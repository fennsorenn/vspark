// 020_overlive_accounts_default: add an is_default flag to overlive_accounts
// and backfill it to the oldest account per project. Overlive signal nodes
// fall back to the project's default account when their `account` config is
// empty (or a stale __preset placeholder after a preset import).
//
// At most one account per project should have is_default = 1; the REST setter
// enforces this in a transaction.

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

export default function migrate(db: Db): void {
  if (!hasColumn(db, 'overlive_accounts', 'is_default')) {
    db.exec(
      'ALTER TABLE overlive_accounts ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0'
    );
  }

  // Backfill: for each project, mark the oldest (MIN(created_at)) account
  // as default. Idempotent: if a project already has any account with
  // is_default = 1, leave it alone.
  const projects = db
    .prepare(
      `SELECT project_id FROM overlive_accounts
       WHERE project_id NOT IN (
         SELECT project_id FROM overlive_accounts WHERE is_default = 1
       )
       GROUP BY project_id`
    )
    .all() as Array<{ project_id: string }>;

  for (const { project_id } of projects) {
    db.prepare(
      `UPDATE overlive_accounts
       SET is_default = 1
       WHERE id = (
         SELECT id FROM overlive_accounts
         WHERE project_id = ?
         ORDER BY created_at ASC, id ASC
         LIMIT 1
       )`
    ).run(project_id);
  }
}
