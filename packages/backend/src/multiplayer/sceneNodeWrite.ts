/**
 * Owner-authoritative application of a remote scene_node write (multiplayer
 * Phase 6). A granted remote peer's edit arrives as a `_share_write` envelope;
 * the owner validates it (see {@link ./sharing}) and applies it here — a full
 * upsert or a delete against its own SQLite — then emits via the unified sync hub
 * so the existing share fan-out (`forwardDocOp`) echoes the canonical result to
 * every subscriber, the originator included.
 *
 * This is a focused full-DTO write, deliberately *not* the partial-update REST
 * path (`routes/scene-nodes.ts`): the wire carries the complete node document,
 * and shared Objects don't need the route's scene-instance validation surface.
 * See dev-notes/plans/multiplayer-phase6.md.
 */
import { getDb } from '../db/index.js';
import { sync } from '../sync/index.js';

/** The canonical scene_node DTO carried on the wire (mirrors resources rowToNode). */
export interface SceneNodeDto {
  id: string;
  rootSceneNodeId: string;
  projectId: string;
  parentId: string | null;
  boneAttachment: string | null;
  name: string;
  kind: string;
  filePath: string | null;
  components: Record<string, unknown>;
  properties: Record<string, unknown>;
  hidden?: boolean;
}

/** Whether a scene_node row currently exists (distinguishes create vs update). */
export function sceneNodeExists(id: string): boolean {
  return !!getDb()
    .prepare('SELECT 1 FROM scene_nodes WHERE id = ?')
    .get(id);
}

/** Full upsert of a scene_node from a remote write, then emit so subscribers get
 *  the authoritative echo. INSERT-or-REPLACE semantics (the wire carries the
 *  complete post-edit document). */
export function applySceneNodeUpsert(dto: SceneNodeDto): void {
  getDb()
    .prepare(
      `INSERT INTO scene_nodes
         (id, project_id, root_scene_node_id, parent_id, bone_attachment,
          name, kind, file_path, components, properties, hidden, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id,
         root_scene_node_id = excluded.root_scene_node_id,
         parent_id = excluded.parent_id,
         bone_attachment = excluded.bone_attachment,
         name = excluded.name,
         kind = excluded.kind,
         file_path = excluded.file_path,
         components = excluded.components,
         properties = excluded.properties,
         hidden = excluded.hidden,
         updated_at = datetime('now')`
    )
    .run(
      dto.id,
      dto.projectId,
      dto.rootSceneNodeId,
      dto.parentId ?? null,
      dto.boneAttachment ?? null,
      dto.name,
      dto.kind,
      dto.filePath ?? null,
      JSON.stringify(dto.components ?? {}),
      JSON.stringify(dto.properties ?? {}),
      dto.hidden ? 1 : 0
    );
  // `touch` re-emits the canonical DTO to doc listeners (the share forwarder)
  // without a redundant local WS broadcast.
  sync.document.touch('scene_node', dto.id);
}

/** Delete a scene_node from a remote write, then emit the removal. `route` is the
 *  ancestor hint the read tier uses to resolve subscribers once the row is gone. */
export function applySceneNodeRemove(
  id: string,
  scope?: string,
  route?: string[]
): void {
  // ON DELETE CASCADE on parent_id removes the subtree; emit only the root id.
  getDb().prepare('DELETE FROM scene_nodes WHERE id = ?').run(id);
  sync.document.remove('scene_node', id, scope, route);
}
