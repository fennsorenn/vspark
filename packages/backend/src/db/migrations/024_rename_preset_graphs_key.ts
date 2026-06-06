// 024_rename_preset_graphs_key: Phase-3 follow-up. Rename the persisted preset
// payload key `graphs` -> `automations` to match the vocabulary (the nested
// standalone signal graphs serialized inside a preset are automations).
//
// Stored in `presets.payload` (JSON). Serialize/deserialize now read/write
// `automations`; this rewrites existing rows. The key sits at the payload root
// (one array of automation entries for the whole serialized subtree), so a
// top-level rename suffices. Idempotent: rows already using `automations` (or
// with no automations) are left unchanged.

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
    return; // presets table absent — nothing to do
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
    if (p && typeof p === 'object' && 'graphs' in p && !('automations' in p)) {
      p.automations = p.graphs;
      delete p.graphs;
      db.prepare('UPDATE presets SET payload = ? WHERE id = ?').run(
        JSON.stringify(p),
        row.id
      );
    }
  }
}
