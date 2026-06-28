/**
 * Project snapshot / revert for the assistant's auto-checkpoint-per-turn undo.
 *
 * The agent captures a snapshot of the open project's mesh documents at the
 * start of each turn; if the turn mutated anything, that snapshot becomes
 * revertable, so "undo that" rolls the whole turn back atomically. Snapshot +
 * revert both go through the mesh collections (set/remove), so the change
 * persists AND syncs back to the editor like any other edit.
 *
 * Scope is one project (the project the agent operates in) — it never touches
 * another project's docs.
 */
import { getMeshCollection } from '../mesh/index.js';

type Doc = Record<string, unknown>;

/** Mutable doc collections an assistant turn can touch. Order = parents first;
 *  restore walks it forwards (a node must exist before its behavior persists),
 *  remove walks it backwards (drop owned docs before their node). animation_clip
 *  is excluded — the agent doesn't author FBX/BVH imports. */
const RTYPES = [
  'scene_node',
  'compose_layer',
  'behavior',
  'camera_effect',
  'track_clip',
] as const;
type Rtype = (typeof RTYPES)[number];

export interface ProjectSnapshot {
  projectId: string;
  /** rtype → (id → deep-cloned doc) for docs that belong to the project. */
  docs: Record<Rtype, Map<string, Doc>>;
}

/** The project's scene-node + compose-layer ids, used to resolve which
 *  node/layer-owned docs (behaviors, effects, clips) belong to the project. */
function projectMembership(projectId: string): {
  nodeIds: Set<string>;
  layerIds: Set<string>;
} {
  const nodeIds = new Set<string>();
  const layerIds = new Set<string>();
  for (const d of (getMeshCollection('scene_node')?.all() ?? []) as Doc[])
    if (d.projectId === projectId && typeof d.id === 'string') nodeIds.add(d.id);
  for (const d of (getMeshCollection('compose_layer')?.all() ?? []) as Doc[])
    if (d.projectId === projectId && typeof d.id === 'string') layerIds.add(d.id);
  return { nodeIds, layerIds };
}

function belongsToProject(
  rtype: Rtype,
  d: Doc,
  projectId: string,
  nodeIds: Set<string>,
  layerIds: Set<string>
): boolean {
  switch (rtype) {
    case 'scene_node':
    case 'compose_layer':
      return d.projectId === projectId;
    case 'behavior':
    case 'camera_effect':
      return typeof d.nodeId === 'string' && nodeIds.has(d.nodeId);
    case 'track_clip':
      return (
        (typeof d.ownerNodeId === 'string' && nodeIds.has(d.ownerNodeId)) ||
        (typeof d.ownerLayerId === 'string' && layerIds.has(d.ownerLayerId))
      );
  }
}

/** Capture the project's current document state (deep-cloned). */
export function captureProjectSnapshot(projectId: string): ProjectSnapshot {
  const { nodeIds, layerIds } = projectMembership(projectId);
  const docs = {} as Record<Rtype, Map<string, Doc>>;
  for (const rtype of RTYPES) {
    const m = new Map<string, Doc>();
    for (const d of (getMeshCollection(rtype)?.all() ?? []) as Doc[]) {
      if (typeof d.id !== 'string') continue;
      if (belongsToProject(rtype, d, projectId, nodeIds, layerIds))
        m.set(d.id, structuredClone(d));
    }
    docs[rtype] = m;
  }
  return { projectId, docs };
}

/** Key-order-insensitive structural equality, for "did this doc change?". */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(o)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(o[k]))
      .join(',') +
    '}'
  );
}
const eq = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

/**
 * Revert ONLY the documents the agent changed between two snapshots (its turn's
 * before → after), and only when the doc still holds the agent's after-value —
 * i.e. nobody (user / collaborator) has touched it since. This keeps the undo
 * scoped to the agent's own work: it never resets an unrelated doc a user edited
 * and never deletes a doc a user created. Returns counts of reverted + skipped
 * (docs left alone because they were changed after the turn).
 */
export async function revertChangeSet(
  before: ProjectSnapshot,
  after: ProjectSnapshot
): Promise<{ reverted: number; skipped: number }> {
  let reverted = 0;
  let skipped = 0;

  // The agent's change-set per rtype: ids whose before ≠ after.
  const changed = (rtype: Rtype): string[] => {
    const b = before.docs[rtype];
    const a = after.docs[rtype];
    const ids = new Set([...b.keys(), ...a.keys()]);
    return [...ids].filter((id) => !eq(b.get(id), a.get(id)));
  };

  // Pass 1 — remove docs the agent CREATED (absent in before), child types
  // first, but only if still exactly as the agent left them.
  for (const rtype of [...RTYPES].reverse()) {
    const col = getMeshCollection(rtype);
    if (!col) continue;
    for (const id of changed(rtype)) {
      if (before.docs[rtype].has(id)) continue; // not a creation
      const cur = col.get(id) as Doc | undefined;
      if (!eq(cur, after.docs[rtype].get(id))) {
        skipped++;
        continue;
      }
      await col.remove(id).ack;
      reverted++;
    }
  }

  // Pass 2 — restore docs the agent MODIFIED or DELETED, parent types first.
  for (const rtype of RTYPES) {
    const col = getMeshCollection(rtype);
    if (!col) continue;
    for (const id of changed(rtype)) {
      const beforeDoc = before.docs[rtype].get(id);
      if (beforeDoc === undefined) continue; // a creation (handled in pass 1)
      const cur = col.get(id) as Doc | undefined;
      if (!eq(cur, after.docs[rtype].get(id))) {
        skipped++;
        continue;
      }
      await col.set(id, '', beforeDoc).ack;
      reverted++;
    }
  }
  return { reverted, skipped };
}
