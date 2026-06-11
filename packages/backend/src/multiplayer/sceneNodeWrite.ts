/**
 * Owner-authoritative application of a remote scene_node write (multiplayer
 * Phase 6). A granted remote peer's edit arrives as a `_share_write` envelope;
 * the owner validates it (see {@link ./sharing}) and applies it here — a full
 * upsert or a delete against its own SQLite — then emits via the unified sync
 * hub, whose mesh bridge echoes the canonical result to every subscriber's
 * placed mesh subscription, the originator included.
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

/** Content-only update of an existing node. **Structure is owner-authoritative**:
 *  project_id / root_scene_node_id / parent_id are preserved, never taken from
 *  the wire — the receiver's projection rewrites the root's parent/root to its
 *  local container and the subscriber doesn't even send projectId/rootSceneNodeId.
 *  Covers the v1 edit surface: transform, material/properties, model swap, name,
 *  visibility. Then emit (broadcasts to the owner's own clients + forwards to
 *  subscribers). */
export function applySceneNodeUpdate(dto: SceneNodeDto): void {
  getDb()
    .prepare(
      `UPDATE scene_nodes SET
         name = ?, kind = ?, file_path = ?, components = ?, properties = ?,
         hidden = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(
      dto.name,
      dto.kind,
      dto.filePath ?? null,
      JSON.stringify(dto.components ?? {}),
      JSON.stringify(dto.properties ?? {}),
      dto.hidden ? 1 : 0,
      dto.id
    );
  sync.document.upsert('scene_node', dto.id);
}

/** Create a new node from a remote write. Structure is **derived from the
 *  parent** (owner-authoritative project_id + root_scene_node_id), not trusted
 *  from the wire; the subscriber supplies a fresh id, the parent's owner-side id,
 *  and content. Returns false if the parent vanished. Then emit. */
export function applySceneNodeCreate(dto: SceneNodeDto): boolean {
  const parent = getDb()
    .prepare(
      'SELECT project_id, root_scene_node_id FROM scene_nodes WHERE id = ?'
    )
    .get(dto.parentId ?? '') as
    | { project_id: string; root_scene_node_id: string }
    | undefined;
  if (!parent) return false;
  getDb()
    .prepare(
      `INSERT INTO scene_nodes
         (id, project_id, root_scene_node_id, parent_id, bone_attachment,
          name, kind, file_path, components, properties, hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      dto.id,
      parent.project_id,
      parent.root_scene_node_id,
      dto.parentId,
      dto.boneAttachment ?? null,
      dto.name,
      dto.kind,
      dto.filePath ?? null,
      JSON.stringify(dto.components ?? {}),
      JSON.stringify(dto.properties ?? {}),
      dto.hidden ? 1 : 0
    );
  sync.document.upsert('scene_node', dto.id);
  return true;
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
