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

/** Restore the project to a captured snapshot: re-set every snapshotted doc and
 *  remove project docs created since (present now, absent in the snapshot). */
export async function revertProjectToSnapshot(
  snap: ProjectSnapshot
): Promise<{ restored: number; removed: number }> {
  const { projectId } = snap;
  const { nodeIds, layerIds } = projectMembership(projectId);

  // 1. Remove docs created during the turn — owned docs first, nodes last.
  let removed = 0;
  for (const rtype of [...RTYPES].reverse()) {
    const col = getMeshCollection(rtype);
    if (!col) continue;
    const want = snap.docs[rtype];
    for (const d of (col.all() ?? []) as Doc[]) {
      if (typeof d.id !== 'string') continue;
      if (!belongsToProject(rtype, d, projectId, nodeIds, layerIds)) continue;
      if (!want.has(d.id)) {
        await col.remove(d.id).ack;
        removed++;
      }
    }
  }

  // 2. Restore snapshotted docs — parents first so owned docs persist.
  let restored = 0;
  for (const rtype of RTYPES) {
    const col = getMeshCollection(rtype);
    if (!col) continue;
    for (const [id, doc] of snap.docs[rtype]) {
      await col.set(id, '', doc).ack;
      restored++;
    }
  }
  return { restored, removed };
}
