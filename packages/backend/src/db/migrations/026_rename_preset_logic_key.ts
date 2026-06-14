// 026_rename_preset_logic_key: the standalone-graph feature was renamed
// "Automation" -> "Logic"; the preset payload key follows
// (`automations` -> `logic`). Chain on existing DBs:
// graphs (024) -> automations (024) -> logic (026).
//
// Stored in `presets.payload` (JSON), top-level key. Idempotent: rows already
// using `logic` (or with no logic graphs) are left unchanged.

interface Db {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): void;
  };
}

export default function migrate(db: Db): void {
  let rows: Record<string, unknown>[];
  try {
    rows = db.prepare('SELECT id, payload FROM presets').all();
  } catch {
    return;
  }
  for (const row of rows) {
    const raw = row.payload;
    if (typeof raw !== 'string' || raw.length === 0) continue;
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(raw);
    } catch {
      continue;
    }
    if (p && typeof p === 'object' && 'automations' in p && !('logic' in p)) {
      p.logic = p.automations;
      delete p.automations;
      db.prepare('UPDATE presets SET payload = ? WHERE id = ?').run(
        JSON.stringify(p),
        row.id
      );
    }
  }
}
