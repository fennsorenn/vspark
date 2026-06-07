/**
 * Server resource descriptors for the unified sync layer.
 *
 * Importing this module registers every resource (rtype → load/scope/class) via
 * {@link defineResource}. Imported for side effects from the server entrypoint.
 *
 * Phase 1: the five CRUD document types. Each `load` returns the SAME canonical
 * camelCase DTO the REST `getScenes` mappers produce, so the client can store it
 * directly with no per-message mapper. Fields land in Phase 2, streams Phase 3.
 *
 * Design: dev-notes/plans/unified-sync-layer.md
 */
import { getDb } from '../db/index.js';
import { defineResource } from './registry.js';
import { rowToLayer, type LayerRow } from '../routes/compose-layers.js';
import { loadClip } from '../routes/track-clips.js';

interface SceneNodeRow {
  id: string;
  project_id: string;
  root_scene_node_id: string;
  parent_id: string | null;
  bone_attachment: string | null;
  name: string;
  kind: string;
  file_path: string | null;
  components: string;
  properties: string;
  hidden: number;
}

/** scene_nodes row → the camelCase shape the frontend store/NodeRecord expects. */
function rowToNode(r: SceneNodeRow) {
  return {
    id: r.id,
    rootSceneNodeId: r.root_scene_node_id,
    projectId: r.project_id,
    parentId: r.parent_id,
    boneAttachment: r.bone_attachment,
    name: r.name,
    kind: r.kind,
    filePath: r.file_path,
    components: JSON.parse(r.components || '{}'),
    properties: JSON.parse(r.properties || '{}'),
    hidden: r.hidden === 1,
  };
}

interface BehaviorRow {
  id: string;
  node_id: string;
  kind: string;
  enabled: number;
  config: string;
}

interface CameraEffectRow {
  id: string;
  node_id: string;
  kind: string;
  enabled: number;
  config: string;
}

defineResource<ReturnType<typeof rowToNode>>({
  rtype: 'scene_node',
  cls: 'document',
  scope: (d) => d.rootSceneNodeId,
  load: (id) => {
    const r = getDb()
      .prepare('SELECT * FROM scene_nodes WHERE id = ?')
      .get(id) as unknown as SceneNodeRow | undefined;
    return r ? rowToNode(r) : undefined;
  },
});

defineResource({
  rtype: 'behavior',
  cls: 'document',
  load: (id) => {
    const r = getDb()
      .prepare('SELECT * FROM behaviors WHERE id = ?')
      .get(id) as unknown as BehaviorRow | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      nodeId: r.node_id,
      kind: r.kind,
      enabled: r.enabled === 1,
      config: JSON.parse(r.config || '{}'),
    };
  },
});

defineResource({
  rtype: 'camera_effect',
  cls: 'document',
  load: (id) => {
    const r = getDb()
      .prepare('SELECT * FROM camera_effects WHERE id = ?')
      .get(id) as unknown as CameraEffectRow | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      nodeId: r.node_id,
      kind: r.kind,
      enabled: r.enabled === 1,
      config: JSON.parse(r.config || '{}'),
    };
  },
});

defineResource<ReturnType<typeof rowToLayer>>({
  rtype: 'compose_layer',
  cls: 'document',
  scope: (d) => d.rootComposeSceneId ?? undefined,
  load: (id) => {
    const r = getDb()
      .prepare('SELECT * FROM compose_layers WHERE id = ?')
      .get(id) as unknown as LayerRow | undefined;
    return r ? rowToLayer(r) : undefined;
  },
});

defineResource({
  rtype: 'track_clip',
  cls: 'document',
  load: (id) => loadClip(id) ?? undefined,
});
