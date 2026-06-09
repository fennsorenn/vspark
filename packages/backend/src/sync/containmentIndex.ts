/**
 * Live containment index (server side) — the first integration of the
 * permissioned-sync-mesh core into the running backend.
 *
 * A single {@link ContainmentIndex} over the scene-node tree (+ attachments),
 * hydrated from the DB at startup and kept current from the unified-sync
 * document ops. Share fan-out resolves the owning shared root via this in-memory
 * index instead of walking `parent_id` in SQLite per op; it also supplies the
 * `isDescendant` the grant store consumes. Additive + behavior-equivalent — the
 * object-share path keeps a DB-walk fallback for ids the index hasn't seen
 * (e.g. tmp/spawn nodes that don't flow through sync.document).
 *
 * See dev-notes/plans/permissioned-sync-mesh.md.
 */
import { ContainmentIndex, type SchemaProvider } from '@vspark/shared/sync';
import type { SyncEnvelope } from '@vspark/shared/sync';
import { getDb } from '../db/index.js';

/** Containment schema keyed on the camelCase DTOs the sync layer emits. */
const schema: SchemaProvider = (rtype) => {
  switch (rtype) {
    case 'scene_node':
      return {
        parentField: 'parentId',
        parentTypes: ['scene_node'],
        canBeRoot: true,
        scopeField: 'rootSceneNodeId',
      };
    // Attachments — owned by a scene_node, so a subtree grant/snapshot covers
    // them; non-recursive. (Indexed so subtree() includes them later.)
    case 'behavior':
    case 'camera_effect':
    case 'track_clip':
      return { parentField: 'nodeId', parentTypes: ['scene_node'], canBeRoot: false };
    default:
      return undefined; // not part of the containment tree
  }
};

export const containmentIndex = new ContainmentIndex(schema);

/** Whether the index tracks this rtype (so doc maintenance can skip the rest). */
function indexed(rtype: string): boolean {
  return !!schema(rtype);
}

/** Hydrate the scene-node tree from the DB at startup. */
export function hydrateContainmentIndex(): void {
  const rows = getDb()
    .prepare('SELECT id, parent_id, root_scene_node_id FROM scene_nodes')
    .all() as {
    id: string;
    parent_id: string | null;
    root_scene_node_id: string;
  }[];
  for (const r of rows)
    containmentIndex.upsert('scene_node', r.id, {
      id: r.id,
      parentId: r.parent_id,
      rootSceneNodeId: r.root_scene_node_id,
    });
}

/** Keep the index current from document ops. Register on `sync.onDocument`
 *  BEFORE the share forwarder so the index is updated before fan-out resolves
 *  owning roots. */
export function applyDocToIndex(env: SyncEnvelope): void {
  if (!indexed(env.rtype)) return;
  if (env.op === 'remove') containmentIndex.remove(env.key);
  else if (env.op === 'upsert' && env.data)
    containmentIndex.upsert(env.rtype, env.key, env.data);
}
