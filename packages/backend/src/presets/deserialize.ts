import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { matchAssetByHash, materializeAsset } from './assets.js';

interface PresetPayload {
  format: string;
  rootKind: 'scene_node' | 'compose_layer';
  assets?: Array<{
    presetAssetId: string;
    name: string;
    mime: string;
    size: number;
    sha256: string;
    originalPath: string;
    kind: string;
    dataBase64?: string;
  }>;
  sceneNodes?: Array<{
    presetId: string;
    parentPresetId: string | null;
    name: string;
    kind: string;
    filePresetAssetId: string | null;
    boneAttachment: string | null;
    hidden: boolean;
    properties: Record<string, unknown>;
    components: Array<{
      presetId: string;
      kind: string;
      enabled: boolean;
      sortOrder: number;
      config: Record<string, unknown>;
    }>;
  }>;
  composeLayers?: Array<{
    presetId: string;
    parentPresetId: string | null;
    name: string;
    kind: string;
    assetPresetAssetId: string | null;
    config: Record<string, unknown>;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    anchorH: string;
    anchorV: string;
    sceneOrder: number;
    cameraOrder: number;
    visible: boolean;
    cameraNodePresetId: string | null;
  }>;
  graphs?: Array<{
    presetId: string;
    ownerKind: string;
    ownerPresetId: string;
    name: string;
    enabled: boolean;
    descriptor: unknown;
    nodeState: unknown;
  }>;
  animationClips?: Array<{
    presetId: string;
    sourceNodePresetId: string;
    sourceFilePresetAssetId: string | null;
    clipIndex: number;
    label: string;
    startTime: number;
    endTime: number;
    duration: number;
    fps: number;
  }>;
  trackClips?: Array<{
    presetId: string;
    ownerKind: string;
    ownerPresetId: string;
    name: string;
    duration: number;
    loop: boolean;
    mode: string;
    autoplay: boolean;
    lanes: Array<{
      presetId: string;
      targetKind: string;
      targetPresetId: string;
      paramPath: string;
      defaultValue: number;
      keyframes: Array<{
        presetId: string;
        t: number;
        value: number;
        easing: string;
        inHandleTFraction: number | null;
        inHandleVFraction: number | null;
        outHandleTFraction: number | null;
        outHandleVFraction: number | null;
      }>;
    }>;
  }>;
}

export interface InstantiateResult {
  rootId: string;
  idMap: Record<string, string>;
  missingAssets: string[];
}

export function instantiatePreset(
  payload: PresetPayload,
  target: {
    projectId: string;
    rootSceneNodeId?: string;
    rootComposeSceneId?: string;
    parentId?: string | null;
  }
): InstantiateResult {
  const db = getDb();
  const idMap: Record<string, string> = {};
  const missingAssets: string[] = [];

  function mintId(presetId: string): string {
    const real = randomUUID();
    idMap[presetId] = real;
    return real;
  }

  function resolveId(presetId: string): string {
    return idMap[presetId] ?? presetId;
  }

  // Resolve assets
  const assetMap = new Map<
    string,
    { filePath: string | null; assetFileId: string | null }
  >();
  for (const asset of payload.assets ?? []) {
    const match = matchAssetByHash(target.projectId, asset.sha256);
    if (match?.assetFileId) {
      assetMap.set(asset.presetAssetId, {
        filePath: match.storedPath,
        assetFileId: match.assetFileId,
      });
      continue;
    }
    if (asset.dataBase64) {
      const result = materializeAsset(
        target.projectId,
        asset.name,
        asset.mime,
        asset.dataBase64
      );
      assetMap.set(asset.presetAssetId, {
        filePath: result.storedPath,
        assetFileId: result.assetFileId,
      });
      continue;
    }
    missingAssets.push(asset.name);
    assetMap.set(asset.presetAssetId, { filePath: null, assetFileId: null });
  }

  let rootId = '';

  if (payload.rootKind === 'scene_node' && payload.sceneNodes) {
    // Insert scene nodes parents-first (they're subtree-ordered)
    for (const node of payload.sceneNodes) {
      const realId = mintId(node.presetId);
      if (!rootId) rootId = realId;

      const parentId = node.parentPresetId
        ? resolveId(node.parentPresetId)
        : (target.parentId ?? null);

      const filePath = node.filePresetAssetId
        ? (assetMap.get(node.filePresetAssetId)?.filePath ?? null)
        : null;

      db.prepare(
        `INSERT INTO scene_nodes (id, project_id, root_scene_node_id, parent_id, bone_attachment, name, kind, file_path, components, properties, hidden)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        realId,
        target.projectId,
        target.rootSceneNodeId ?? '',
        parentId,
        node.boneAttachment,
        node.name,
        node.kind,
        filePath,
        JSON.stringify({}),
        JSON.stringify(node.properties),
        node.hidden ? 1 : 0
      );

      // Insert components
      for (const comp of node.components) {
        const compId = mintId(comp.presetId);
        db.prepare(
          `INSERT INTO node_components (id, node_id, kind, enabled, config, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          compId,
          realId,
          comp.kind,
          comp.enabled ? 1 : 0,
          JSON.stringify(comp.config),
          comp.sortOrder
        );
      }
    }

    // Insert animation clips
    for (const clip of payload.animationClips ?? []) {
      const clipId = mintId(clip.presetId);
      const sourceNodeId = resolveId(clip.sourceNodePresetId);
      const sourceFilePath = clip.sourceFilePresetAssetId
        ? (assetMap.get(clip.sourceFilePresetAssetId)?.filePath ?? '')
        : '';
      db.prepare(
        `INSERT INTO animation_clips (id, name, source_node_id, source_file_path, clip_index, label, start_time, end_time, duration, fps)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        clipId,
        clip.label,
        sourceNodeId,
        sourceFilePath,
        clip.clipIndex,
        clip.label,
        clip.startTime,
        clip.endTime,
        clip.duration,
        clip.fps
      );
    }
  }

  if (payload.rootKind === 'compose_layer' && payload.composeLayers) {
    for (const layer of payload.composeLayers) {
      const realId = mintId(layer.presetId);
      if (!rootId) rootId = realId;

      const parentId = layer.parentPresetId
        ? resolveId(layer.parentPresetId)
        : (target.parentId ?? null);

      const assetId = layer.assetPresetAssetId
        ? (assetMap.get(layer.assetPresetAssetId)?.assetFileId ?? null)
        : null;

      db.prepare(
        `INSERT INTO compose_layers (id, project_id, root_compose_scene_id, camera_node_id, parent_id, name, kind, asset_id, config,
           x, y, width, height, rotation, anchor_h, anchor_v, scene_order, camera_order, visible)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        realId,
        target.projectId,
        target.rootComposeSceneId ?? null,
        null,
        parentId,
        layer.name,
        layer.kind,
        assetId,
        JSON.stringify(layer.config),
        layer.x,
        layer.y,
        layer.width,
        layer.height,
        layer.rotation,
        layer.anchorH,
        layer.anchorV,
        layer.sceneOrder,
        layer.cameraOrder,
        layer.visible ? 1 : 0
      );
    }
  }

  // Insert graphs
  for (const graph of payload.graphs ?? []) {
    const graphId = mintId(graph.presetId);
    const ownerId = resolveId(graph.ownerPresetId);
    db.prepare(
      `INSERT INTO graphs (id, owner_kind, owner_id, name, enabled, descriptor, node_state)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      graphId,
      graph.ownerKind,
      ownerId,
      graph.name,
      graph.enabled ? 1 : 0,
      JSON.stringify(graph.descriptor),
      JSON.stringify(graph.nodeState)
    );
  }

  // Insert track clips
  for (const tc of payload.trackClips ?? []) {
    const clipId = mintId(tc.presetId);
    const ownerId = resolveId(tc.ownerPresetId);
    db.prepare(
      `INSERT INTO track_clips (id, root_scene_node_id, name, duration, loop, mode, autoplay, owner_kind, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      clipId,
      target.rootSceneNodeId ?? '',
      tc.name,
      tc.duration,
      tc.loop ? 1 : 0,
      tc.mode,
      tc.autoplay ? 1 : 0,
      tc.ownerKind,
      ownerId
    );

    for (const lane of tc.lanes) {
      const laneId = mintId(lane.presetId);
      const targetId = resolveId(lane.targetPresetId);
      db.prepare(
        `INSERT INTO track_clip_lanes (id, clip_id, target_kind, target_id, param_path, default_value)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        laneId,
        clipId,
        lane.targetKind,
        targetId,
        lane.paramPath,
        lane.defaultValue
      );

      for (const kf of lane.keyframes) {
        const kfId = mintId(kf.presetId);
        db.prepare(
          `INSERT INTO track_clip_keyframes (id, lane_id, t, value, easing, in_handle_t_fraction, in_handle_v_fraction, out_handle_t_fraction, out_handle_v_fraction)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          kfId,
          laneId,
          kf.t,
          kf.value,
          kf.easing,
          kf.inHandleTFraction,
          kf.inHandleVFraction,
          kf.outHandleTFraction,
          kf.outHandleVFraction
        );
      }
    }
  }

  return { rootId, idMap, missingAssets };
}
