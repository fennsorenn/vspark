// 047_behavior_graphs: Behaviors get a STORED, editable graph (plan:
// dev-notes/plans/actions.md Phase 4; module:
// dev-notes/modules/component-managers.md → "Stored, editable graphs").
//
// Until now each behavior's signal graph was generated from its kind's code
// template every time the manager started it, and never stored. From here on:
//
//   - the graph is a `logic` row with owner_kind = 'behavior',
//     owner_id = behaviors.id, created under the behavior's runtime graph id
//     (e.g. `vmc-pipeline:<behaviorId>`), so the canvas, mesh sync, undo and
//     the signal routes (node states / fire) all keep working by that id;
//   - `behaviors.template_fingerprint` records which template output the graph
//     was generated from (positions excluded — the same fingerprint Actions
//     use), so the editor can tell "Modified" and "template update available".
//
// Backfill: every existing behavior whose kind has a template gets its graph
// generated from the CURRENT template and the matching fingerprint, so it
// starts unmodified. The templates are imported rather than frozen here (unlike
// 044's frozen section map): a database that runs this later should get the
// template of the code it runs with — an older copy would only be regenerated
// again by the boot sync. Kinds without a graph (api_controller) are skipped.
//
// Idempotent: the column is added only when missing, and a behavior that
// already owns a graph keeps it.

import { toDescriptorDoc } from '@vspark/shared/signal';
import {
  behaviorTemplateFingerprint,
  behaviorTemplateGraph,
} from '../../behaviors/templates.js';

interface Db {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): void;
  };
}

function parseObj(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export default function migrate(db: Db): void {
  const cols = db.prepare('PRAGMA table_info(behaviors)').all();
  if (!cols.some((c) => c.name === 'template_fingerprint'))
    db.prepare(
      'ALTER TABLE behaviors ADD COLUMN template_fingerprint TEXT'
    ).run();

  const rows = db.prepare('SELECT id, kind, config FROM behaviors').all() as {
    id: string;
    kind: string;
    config: string;
  }[];
  for (const r of rows) {
    const config = parseObj(r.config);
    const graph = behaviorTemplateGraph(r.kind, r.id, config);
    const fp = behaviorTemplateFingerprint(r.kind, config);
    if (!graph || !fp) continue;
    const owned = db
      .prepare(
        "SELECT 1 FROM logic WHERE owner_kind = 'behavior' AND owner_id = ?"
      )
      .get(r.id);
    if (owned) continue;
    db.prepare(
      `INSERT OR IGNORE INTO logic (id, owner_kind, owner_id, name, enabled, descriptor)
       VALUES (?, 'behavior', ?, ?, 1, ?)`
    ).run(graph.id, r.id, graph.label, JSON.stringify(toDescriptorDoc(graph)));
    db.prepare(
      'UPDATE behaviors SET template_fingerprint = ? WHERE id = ?'
    ).run(fp, r.id);
  }
}
