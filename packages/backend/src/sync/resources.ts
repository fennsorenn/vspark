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
 * `save` / `remove` are idempotent persistence helpers used by the generic
 * applyRemote path (step 1 of the mesh refactor). The logic is adapted from
 * the bespoke writers in multiplayer/collabScene.ts and
 * multiplayer/sceneNodeWrite.ts — those modules are intentionally left intact
 * until a later refactor step rewires them.
 *
 * Round-trip guarantee: load(id) after save(dto) returns a DTO deep-equal to
 * dto for all document fields (server-managed timestamps createdAt/updatedAt
 * may differ).
 *
 * Design: dev-notes/plans/unified-sync-layer.md
 */
import { getDb } from '../db/index.js';
import { defineResource } from './registry.js';
import { rowToLayer, type LayerRow } from '../routes/compose-layers.js';
import { loadClip } from '../routes/track-clips.js';

interface StageObjectRow {
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

/** scene_nodes row → the camelCase shape the frontend store/StageObject expects. */
function rowToNode(r: StageObjectRow) {
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
  sort_order: number;
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
      .get(id) as unknown as StageObjectRow | undefined;
    return r ? rowToNode(r) : undefined;
  },
  save: (dto) => {
    getDb()
      .prepare(
        `INSERT INTO scene_nodes
           (id, project_id, root_scene_node_id, parent_id, bone_attachment,
            name, kind, file_path, components, properties, hidden)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id          = excluded.project_id,
           root_scene_node_id  = excluded.root_scene_node_id,
           parent_id           = excluded.parent_id,
           bone_attachment     = excluded.bone_attachment,
           name                = excluded.name,
           kind                = excluded.kind,
           file_path           = excluded.file_path,
           components          = excluded.components,
           properties          = excluded.properties,
           hidden              = excluded.hidden,
           updated_at          = datetime('now')`
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
  },
  remove: (id) => {
    // ON DELETE CASCADE on parent_id removes the subtree automatically.
    getDb().prepare('DELETE FROM scene_nodes WHERE id = ?').run(id);
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
      sortOrder: r.sort_order ?? 0,
    };
  },
  save: (dto) => {
    const d = dto as {
      id: string;
      nodeId: string;
      kind: string;
      enabled: boolean;
      config: Record<string, unknown>;
      sortOrder?: number;
    };
    getDb()
      .prepare(
        `INSERT INTO behaviors (id, node_id, kind, enabled, config, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           node_id    = excluded.node_id,
           kind       = excluded.kind,
           enabled    = excluded.enabled,
           config     = excluded.config,
           sort_order = excluded.sort_order,
           updated_at = datetime('now')`
      )
      .run(
        d.id,
        d.nodeId,
        d.kind,
        d.enabled ? 1 : 0,
        JSON.stringify(d.config ?? {}),
        d.sortOrder ?? 0
      );
  },
  remove: (id) => {
    getDb().prepare('DELETE FROM behaviors WHERE id = ?').run(id);
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
  save: (dto) => {
    const d = dto as { id: string; nodeId: string; kind: string; enabled: boolean; config: Record<string, unknown> };
    getDb()
      .prepare(
        `INSERT INTO camera_effects (id, node_id, kind, enabled, config)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           node_id    = excluded.node_id,
           kind       = excluded.kind,
           enabled    = excluded.enabled,
           config     = excluded.config,
           updated_at = datetime('now')`
      )
      .run(
        d.id,
        d.nodeId,
        d.kind,
        d.enabled ? 1 : 0,
        JSON.stringify(d.config ?? {})
      );
  },
  remove: (id) => {
    getDb().prepare('DELETE FROM camera_effects WHERE id = ?').run(id);
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
  save: (dto) => {
    getDb()
      .prepare(
        `INSERT INTO compose_layers
           (id, project_id, root_compose_scene_id, camera_node_id, parent_id,
            name, kind, asset_id, config, x, y, width, height, rotation,
            anchor_h, anchor_v, scene_order, camera_order, visible)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id            = excluded.project_id,
           root_compose_scene_id = excluded.root_compose_scene_id,
           camera_node_id        = excluded.camera_node_id,
           parent_id             = excluded.parent_id,
           name                  = excluded.name,
           kind                  = excluded.kind,
           asset_id              = excluded.asset_id,
           config                = excluded.config,
           x                     = excluded.x,
           y                     = excluded.y,
           width                 = excluded.width,
           height                = excluded.height,
           rotation              = excluded.rotation,
           anchor_h              = excluded.anchor_h,
           anchor_v              = excluded.anchor_v,
           scene_order           = excluded.scene_order,
           camera_order          = excluded.camera_order,
           visible               = excluded.visible,
           updated_at            = datetime('now')`
      )
      .run(
        dto.id,
        dto.projectId,
        dto.rootComposeSceneId ?? null,
        dto.cameraNodeId ?? null,
        dto.parentId ?? null,
        dto.name,
        dto.kind,
        dto.assetId ?? null,
        JSON.stringify(dto.config ?? {}),
        dto.x,
        dto.y,
        dto.width,
        dto.height,
        dto.rotation,
        dto.anchorH,
        dto.anchorV,
        dto.sceneOrder,
        dto.cameraOrder,
        dto.visible ? 1 : 0
      );
  },
  remove: (id) => {
    // Dependent camera layers (scene_order re-anchoring) is a UI concern handled
    // by the REST route. For generic sync removal, a plain delete is sufficient —
    // the schema does not cascade on compose_layers.parent_id automatically, but
    // child layers reference the deleted parent via parent_id (nullable FK), so
    // they are left in place (orphaned) until the caller resolves them.
    getDb().prepare('DELETE FROM compose_layers WHERE id = ?').run(id);
  },
});

defineResource({
  rtype: 'track_clip',
  cls: 'document',
  load: (id) => loadClip(id) ?? undefined,
  save: (dto) => {
    // `dto` is the canonical DTO returned by loadClip/mapClip:
    //   { id, ownerNodeId, ownerLayerId, name, duration, loop, mode, autoplay,
    //     startedAt, createdAt, lanes:[{id, clipId, targetKind, targetId,
    //     paramPath, defaultValue, keyframes:[...]}], events:[...] }
    //
    // Persist strategy: delete-then-reinsert children (same as applyClipDto in
    // collabScene.ts) so re-applying an existing clip is idempotent without
    // hitting UNIQUE constraint errors on stale child ids.
    // started_at and created_at are preserved when present in the DTO so that
    // load(id) after save(dto) returns the same values.
    const d = dto as {
      id: string;
      ownerNodeId: string | null;
      ownerLayerId: string | null;
      name: string;
      duration: number;
      loop: boolean;
      mode: string;
      autoplay: boolean;
      startedAt?: number | null;
      createdAt?: string;
      lanes: Array<{
        id: string;
        clipId?: string;
        targetKind: string;
        targetId: string;
        paramPath: string;
        defaultValue: number;
        keyframes: Array<{
          id: string;
          t: number;
          value: number;
          easing: string;
          inHandleTFraction: number | null;
          inHandleVFraction: number | null;
          outHandleTFraction: number | null;
          outHandleVFraction: number | null;
        }>;
      }>;
      events: Array<{
        id: string;
        t: number;
        action: string;
        targetKind: string;
        targetId: string;
        payload: Record<string, unknown> | null;
      }>;
    };
    const db = getDb();
    // created_at fallback chain: DTO → the prior row (replica DTOs built by
    // the write-through routes don't carry timestamps, and the reinsert must
    // not reset creation time on every edit) → now (genuinely new clip).
    const prior = db
      .prepare('SELECT created_at FROM track_clips WHERE id = ?')
      .get(d.id) as { created_at: string } | undefined;
    // Clear children explicitly (mirrors applyClipDto; avoids stale-id UNIQUE violations).
    const oldLanes = db
      .prepare('SELECT id FROM track_clip_lanes WHERE clip_id = ?')
      .all(d.id) as { id: string }[];
    for (const l of oldLanes)
      db.prepare('DELETE FROM track_clip_keyframes WHERE lane_id = ?').run(l.id);
    db.prepare('DELETE FROM track_clip_lanes WHERE clip_id = ?').run(d.id);
    db.prepare('DELETE FROM track_clip_events WHERE clip_id = ?').run(d.id);
    db.prepare('DELETE FROM track_clips WHERE id = ?').run(d.id);
    // Reinsert the clip row, preserving started_at and created_at for round-trip.
    db.prepare(
      `INSERT INTO track_clips
         (id, owner_node_id, owner_layer_id, name, duration, loop, mode, autoplay,
          started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
    ).run(
      d.id,
      d.ownerNodeId ?? null,
      d.ownerLayerId ?? null,
      d.name,
      d.duration,
      d.loop ? 1 : 0,
      d.mode,
      d.autoplay ? 1 : 0,
      d.startedAt ?? null,
      d.createdAt ?? prior?.created_at ?? null
    );
    for (const lane of d.lanes ?? []) {
      db.prepare(
        `INSERT INTO track_clip_lanes
           (id, clip_id, target_kind, target_id, param_path, default_value)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(lane.id, d.id, lane.targetKind, lane.targetId, lane.paramPath, lane.defaultValue);
      for (const kf of lane.keyframes ?? [])
        db.prepare(
          `INSERT INTO track_clip_keyframes
             (id, lane_id, t, value, easing, in_handle_t_fraction, in_handle_v_fraction,
              out_handle_t_fraction, out_handle_v_fraction)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          kf.id, lane.id, kf.t, kf.value, kf.easing,
          kf.inHandleTFraction ?? null, kf.inHandleVFraction ?? null,
          kf.outHandleTFraction ?? null, kf.outHandleVFraction ?? null
        );
    }
    for (const ev of d.events ?? [])
      db.prepare(
        `INSERT INTO track_clip_events (id, clip_id, t, action, target_kind, target_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        ev.id, d.id, ev.t, ev.action, ev.targetKind, ev.targetId,
        ev.payload != null ? JSON.stringify(ev.payload) : null
      );
  },
  remove: (id) => {
    // track_clip_lanes and track_clip_events reference track_clips(id) with
    // ON DELETE CASCADE, so the child rows are removed automatically.
    getDb().prepare('DELETE FROM track_clips WHERE id = ?').run(id);
  },
});

// --- Stream resources (Phase 3) ---------------------------------------------
// Declared so the four-class API surface is complete and these names are
// reserved. Lossy/latest-wins, no load/scope/snapshot. The live broadcasts
// (pose_broadcast / blendshapes_broadcast / ik_broadcast) still emit their
// legacy WS kinds; migrating that 90 Hz hot path onto sync.stream.publish is
// deferred until it can be runtime-verified (see the design doc, Phase 3).
interface AnimationClipRow {
  id: string;
  name: string;
  source_node_id: string;
  source_file_path: string;
  clip_index: number;
  label: string;
  start_time: number;
  end_time: number;
  duration: number;
  fps: number;
  created_at: string;
}

defineResource({
  rtype: 'animation_clip',
  cls: 'document',
  load: (id) => {
    const r = getDb()
      .prepare('SELECT * FROM animation_clips WHERE id = ?')
      .get(id) as unknown as AnimationClipRow | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      name: r.name,
      sourceNodeId: r.source_node_id,
      sourceFilePath: r.source_file_path,
      clipIndex: r.clip_index,
      label: r.label,
      startTime: r.start_time,
      endTime: r.end_time,
      duration: r.duration,
      fps: r.fps,
      createdAt: r.created_at,
    };
  },
  save: (dto) => {
    const d = dto as {
      id: string;
      name: string;
      sourceNodeId: string;
      sourceFilePath: string;
      clipIndex: number;
      label: string;
      startTime: number;
      endTime: number;
      duration: number;
      fps: number;
      createdAt?: string;
    };
    const db = getDb();
    // created_at fallback chain: DTO → prior row → now (replica DTOs built by
    // write-through routes carry no timestamps; an edit must not reset it).
    const prior = db
      .prepare('SELECT created_at FROM animation_clips WHERE id = ?')
      .get(d.id) as { created_at: string } | undefined;
    db.prepare(
      `INSERT INTO animation_clips
         (id, name, source_node_id, source_file_path, clip_index, label,
          start_time, end_time, duration, fps, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
       ON CONFLICT(id) DO UPDATE SET
         name             = excluded.name,
         source_node_id   = excluded.source_node_id,
         source_file_path = excluded.source_file_path,
         clip_index       = excluded.clip_index,
         label            = excluded.label,
         start_time       = excluded.start_time,
         end_time         = excluded.end_time,
         duration         = excluded.duration,
         fps              = excluded.fps`
    ).run(
      d.id,
      d.name,
      d.sourceNodeId,
      d.sourceFilePath,
      d.clipIndex ?? 0,
      d.label ?? d.name,
      d.startTime ?? 0,
      d.endTime ?? d.duration,
      d.duration,
      d.fps ?? 30,
      d.createdAt ?? prior?.created_at ?? null
    );
  },
  remove: (id) => {
    getDb().prepare('DELETE FROM animation_clips WHERE id = ?').run(id);
  },
});

interface ScheduledAnimationRow {
  id: string;
  avatar_node_id: string;
  clip_id: string;
  start_epoch: number;
  speed: number;
  loop: number;
  created_at: string;
}

defineResource({
  rtype: 'scheduled_animation',
  cls: 'document',
  load: (id) => {
    const r = getDb()
      .prepare('SELECT * FROM scheduled_animations WHERE id = ?')
      .get(id) as unknown as ScheduledAnimationRow | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      avatarNodeId: r.avatar_node_id,
      clipId: r.clip_id,
      startEpoch: r.start_epoch,
      speed: r.speed,
      loop: r.loop === 1,
      createdAt: r.created_at,
    };
  },
  save: (dto) => {
    const d = dto as {
      id: string;
      avatarNodeId: string;
      clipId: string;
      startEpoch: number;
      speed?: number;
      loop?: boolean;
      createdAt?: string;
    };
    const db = getDb();
    const prior = db
      .prepare('SELECT created_at FROM scheduled_animations WHERE id = ?')
      .get(d.id) as { created_at: string } | undefined;
    db.prepare(
      `INSERT INTO scheduled_animations
         (id, avatar_node_id, clip_id, start_epoch, speed, loop, created_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
       ON CONFLICT(id) DO UPDATE SET
         avatar_node_id = excluded.avatar_node_id,
         clip_id        = excluded.clip_id,
         start_epoch    = excluded.start_epoch,
         speed          = excluded.speed,
         loop           = excluded.loop`
    ).run(
      d.id,
      d.avatarNodeId,
      d.clipId,
      d.startEpoch,
      d.speed ?? 1,
      d.loop ? 1 : 0,
      d.createdAt ?? prior?.created_at ?? null
    );
  },
  remove: (id) => {
    getDb().prepare('DELETE FROM scheduled_animations WHERE id = ?').run(id);
  },
});

// legacy WS kinds; migrating that 90 Hz hot path onto sync.stream.publish is
// deferred until it can be runtime-verified (see the design doc, Phase 3).
defineResource({ rtype: 'vmc_pose', cls: 'stream' });
defineResource({ rtype: 'vmc_blendshapes', cls: 'stream' });
defineResource({ rtype: 'pose_ik_targets', cls: 'stream' });
