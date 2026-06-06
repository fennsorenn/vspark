// 023_rename_behavior_context_kinds: Phase-3 follow-up to the vocabulary refactor.
// Rewrite persisted signal-graph descriptors so they match the renamed node kinds
// and port name:
//   node kind  'component_id'     -> 'behavior_id'
//   node kind  'component_config' -> 'behavior_config'
//   port name  'componentId'      -> 'behaviorId'   (input port on the
//              pose_broadcast / blendshapes_broadcast nodes — appears as an
//              edge `toPort`/`fromPort` and as a value-input fallback config key)
//   config key '_componentConfig' -> '_behaviorConfig'
//
// Stored descriptors live in `automations.descriptor` (user-built automations) and,
// nested, inside `presets.payload`. Component-backing graphs (breathing, lipsync, …)
// are code-generated at boot, not stored, so they need no migration — only the
// templates in source. The behaviour-context kinds are rejected from automations at
// validation time, so the kind rewrite is defensive; the real target is the port.
//
// Walks every {nodes,edges} descriptor object at any nesting depth. Idempotent:
// re-running finds nothing to change (old strings already gone).

interface Db {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): void;
  };
}

type Json = Record<string, unknown>;

function rewriteDescriptor(d: Json): void {
  const nodes = d.nodes;
  if (Array.isArray(nodes)) {
    for (const n of nodes as Json[]) {
      if (n.kind === 'component_id') n.kind = 'behavior_id';
      else if (n.kind === 'component_config') n.kind = 'behavior_config';
      const cfg = n.defaultConfig as Json | undefined;
      if (cfg && typeof cfg === 'object') {
        if ('componentId' in cfg) {
          cfg.behaviorId = cfg.componentId;
          delete cfg.componentId;
        }
        if ('_componentConfig' in cfg) {
          cfg._behaviorConfig = cfg._componentConfig;
          delete cfg._componentConfig;
        }
      }
    }
  }
  const edges = d.edges;
  if (Array.isArray(edges)) {
    for (const e of edges as Json[]) {
      if (e.toPort === 'componentId') e.toPort = 'behaviorId';
      if (e.fromPort === 'componentId') e.fromPort = 'behaviorId';
    }
  }
}

function walk(o: unknown): void {
  if (Array.isArray(o)) {
    o.forEach(walk);
    return;
  }
  if (o && typeof o === 'object') {
    const obj = o as Json;
    if (Array.isArray(obj.nodes) && Array.isArray(obj.edges)) rewriteDescriptor(obj);
    for (const k of Object.keys(obj)) walk(obj[k]);
  }
}

function rewriteColumn(
  db: Db,
  table: string,
  column: string
): void {
  let rows: Record<string, unknown>[];
  try {
    rows = db.prepare(`SELECT id, ${column} FROM ${table}`).all();
  } catch {
    return; // table/column absent on this DB — nothing to do
  }
  for (const row of rows) {
    const raw = row[column];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // not JSON — leave untouched
    }
    walk(parsed);
    const next = JSON.stringify(parsed);
    if (next !== raw) {
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(
        next,
        row.id
      );
    }
  }
}

export default function migrate(db: Db): void {
  rewriteColumn(db, 'automations', 'descriptor');
  rewriteColumn(db, 'presets', 'payload');
}
