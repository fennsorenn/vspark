import { getDb } from '../db/index.js';
import {
  getSceneNodeDescendants,
  getComposeLayerDescendants,
} from './subtree.js';
import { hashFile, resolveAbsPath, fileToBase64 } from './assets.js';

interface SerializeOpts {
  embedAssets?: boolean;
}

interface PresetAsset {
  presetAssetId: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  originalPath: string;
  kind: 'scene_node_file' | 'asset_file';
  dataBase64?: string;
}

let _assetSeq = 0;
function nextAssetId(): string {
  return `a${++_assetSeq}`;
}
let _nodeSeq = 0;
function nextPresetId(prefix: string): string {
  return `${prefix}${++_nodeSeq}`;
}

export function serializeSceneNodeSubtree(
  rootId: string,
  opts: SerializeOpts = {}
) {
  _assetSeq = 0;
  _nodeSeq = 0;
  const db = getDb();

  const nodeIds = getSceneNodeDescendants(rootId);
  const realToPreset = new Map<string, string>();
  const assets: PresetAsset[] = [];
  const assetPathToPresetId = new Map<string, string>();

  function ensureAsset(
    absPath: string | null,
    name: string,
    mime: string,
    kind: 'scene_node_file' | 'asset_file'
  ): string | null {
    if (!absPath) return null;
    if (assetPathToPresetId.has(absPath))
      return assetPathToPresetId.get(absPath)!;
    const sha256 = hashFile(absPath);
    const id = nextAssetId();
    const asset: PresetAsset = {
      presetAssetId: id,
      name,
      mime,
      size: 0,
      sha256,
      originalPath: absPath,
      kind,
    };
    try {
      const { statSync } = require('fs') as typeof import('fs');
      asset.size = statSync(absPath).size;
    } catch {
      /* ignore */
    }
    if (opts.embedAssets) {
      const b64 = fileToBase64(absPath);
      if (b64) asset.dataBase64 = b64;
    }
    assets.push(asset);
    assetPathToPresetId.set(absPath, id);
    return id;
  }

  const sceneNodes: unknown[] = [];
  for (const nid of nodeIds) {
    const row = db
      .prepare('SELECT * FROM scene_nodes WHERE id = ?')
      .get(nid) as Record<string, unknown>;
    if (!row) continue;
    const presetId = nextPresetId('n');
    realToPreset.set(nid, presetId);

    let filePresetAssetId: string | null = null;
    if (row.file_path) {
      const absPath = resolveAbsPath(row.file_path as string);
      filePresetAssetId = ensureAsset(
        absPath,
        (row.file_path as string).split('/').pop() || 'file',
        '',
        'scene_node_file'
      );
    }

    const components = db
      .prepare(
        'SELECT * FROM node_components WHERE node_id = ? ORDER BY sort_order'
      )
      .all(nid) as Record<string, unknown>[];

    sceneNodes.push({
      presetId,
      parentPresetId: row.parent_id
        ? (realToPreset.get(row.parent_id as string) ?? null)
        : null,
      name: row.name,
      kind: row.kind,
      filePresetAssetId,
      boneAttachment: row.bone_attachment ?? null,
      hidden: (row.hidden as number) === 1,
      properties: JSON.parse((row.properties as string) || '{}'),
      components: components.map((c) => ({
        presetId: nextPresetId('c'),
        kind: c.kind,
        enabled: (c.enabled as number) === 1,
        sortOrder: c.sort_order ?? 0,
        config: JSON.parse((c.config as string) || '{}'),
      })),
    });
  }

  // Graphs owned by nodes in the subtree
  const placeholders = nodeIds.map(() => '?').join(',');
  const graphRows = db
    .prepare(
      `SELECT * FROM graphs WHERE owner_kind = 'scene_node' AND owner_id IN (${placeholders}) ORDER BY created_at`
    )
    .all(...nodeIds) as Record<string, unknown>[];

  const graphs = graphRows.map((g) => ({
    presetId: nextPresetId('g'),
    ownerKind: 'scene_node' as const,
    ownerPresetId: realToPreset.get(g.owner_id as string) ?? '',
    name: g.name,
    enabled: (g.enabled as number) === 1,
    descriptor: JSON.parse((g.descriptor as string) || '{}'),
    nodeState: JSON.parse((g.node_state as string) || '{}'),
  }));

  // Animation clips
  const clipRows = db
    .prepare(
      `SELECT * FROM animation_clips WHERE source_node_id IN (${placeholders}) ORDER BY clip_index`
    )
    .all(...nodeIds) as Record<string, unknown>[];

  const animationClips = clipRows.map((c) => {
    let sourceFilePresetAssetId: string | null = null;
    if (c.source_file_path) {
      const absPath = resolveAbsPath(c.source_file_path as string);
      sourceFilePresetAssetId = ensureAsset(
        absPath,
        (c.source_file_path as string).split('/').pop() || 'file',
        '',
        'scene_node_file'
      );
    }
    return {
      presetId: nextPresetId('ac'),
      sourceNodePresetId: realToPreset.get(c.source_node_id as string) ?? '',
      sourceFilePresetAssetId,
      clipIndex: c.clip_index,
      label: c.label ?? c.name,
      startTime: c.start_time,
      endTime: c.end_time,
      duration: c.duration,
      fps: c.fps,
    };
  });

  // Track clips owned by nodes in the subtree
  const trackClipRows = db
    .prepare(
      `SELECT * FROM track_clips WHERE owner_kind = 'scene_node' AND owner_id IN (${placeholders}) ORDER BY created_at`
    )
    .all(...nodeIds) as Record<string, unknown>[];

  const trackClips = trackClipRows.map((tc) => {
    const lanes = db
      .prepare('SELECT * FROM track_clip_lanes WHERE clip_id = ?')
      .all(tc.id as string) as Record<string, unknown>[];
    return {
      presetId: nextPresetId('tc'),
      ownerKind: 'scene_node' as const,
      ownerPresetId: realToPreset.get(tc.owner_id as string) ?? '',
      name: tc.name,
      duration: tc.duration,
      loop: (tc.loop as number) === 1,
      mode: tc.mode,
      autoplay: (tc.autoplay as number) === 1,
      lanes: lanes.map((lane) => {
        const kfs = db
          .prepare(
            'SELECT * FROM track_clip_keyframes WHERE lane_id = ? ORDER BY t'
          )
          .all(lane.id as string) as Record<string, unknown>[];
        const targetPresetId =
          realToPreset.get(lane.target_id as string) ??
          (lane.target_id as string);
        return {
          presetId: nextPresetId('ln'),
          targetKind: lane.target_kind,
          targetPresetId,
          paramPath: lane.param_path,
          defaultValue: lane.default_value ?? 0,
          keyframes: kfs.map((k) => ({
            presetId: nextPresetId('k'),
            t: k.t,
            value: k.value,
            easing: k.easing ?? 'linear',
            inHandleTFraction: k.in_handle_t_fraction ?? null,
            inHandleVFraction: k.in_handle_v_fraction ?? null,
            outHandleTFraction: k.out_handle_t_fraction ?? null,
            outHandleVFraction: k.out_handle_v_fraction ?? null,
          })),
        };
      }),
    };
  });

  const rootNode = db
    .prepare(
      'SELECT project_id, root_scene_node_id FROM scene_nodes WHERE id = ?'
    )
    .get(rootId) as
    | { project_id: string; root_scene_node_id: string }
    | undefined;

  return {
    format: 'vspark.preset.v2' as const,
    rootKind: 'scene_node' as const,
    exportedAt: new Date().toISOString(),
    exportedFrom: {
      projectId: rootNode?.project_id ?? '',
      rootSceneNodeId: rootNode?.root_scene_node_id ?? '',
      rootId,
    },
    assets,
    sceneNodes,
    graphs: graphs.length > 0 ? graphs : undefined,
    animationClips: animationClips.length > 0 ? animationClips : undefined,
    trackClips: trackClips.length > 0 ? trackClips : undefined,
  };
}

export function serializeComposeLayerSubtree(
  rootId: string,
  opts: SerializeOpts = {}
) {
  _assetSeq = 0;
  _nodeSeq = 0;
  const db = getDb();

  const layerIds = getComposeLayerDescendants(rootId);
  const realToPreset = new Map<string, string>();
  const assets: PresetAsset[] = [];
  const assetIdToPresetId = new Map<string, string>();

  function ensureLayerAsset(assetId: string | null): string | null {
    if (!assetId) return null;
    if (assetIdToPresetId.has(assetId)) return assetIdToPresetId.get(assetId)!;
    const row = db
      .prepare('SELECT * FROM asset_files WHERE id = ?')
      .get(assetId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const absPath = resolveAbsPath(row.stored_path as string);
    const sha256 = hashFile(absPath);
    const id = nextAssetId();
    const asset: PresetAsset = {
      presetAssetId: id,
      name: row.original_name as string,
      mime: row.mime_type as string,
      size: (row.size as number) ?? 0,
      sha256,
      originalPath: absPath,
      kind: 'asset_file',
    };
    if (opts.embedAssets) {
      const b64 = fileToBase64(absPath);
      if (b64) asset.dataBase64 = b64;
    }
    assets.push(asset);
    assetIdToPresetId.set(assetId, id);
    return id;
  }

  const composeLayers: unknown[] = [];
  for (const lid of layerIds) {
    const row = db
      .prepare('SELECT * FROM compose_layers WHERE id = ?')
      .get(lid) as Record<string, unknown>;
    if (!row) continue;
    const presetId = nextPresetId('l');
    realToPreset.set(lid, presetId);

    composeLayers.push({
      presetId,
      parentPresetId: row.parent_id
        ? (realToPreset.get(row.parent_id as string) ?? null)
        : null,
      name: row.name,
      kind: row.kind,
      assetPresetAssetId: ensureLayerAsset(row.asset_id as string | null),
      config: JSON.parse((row.config as string) || '{}'),
      x: row.x,
      y: row.y,
      width: row.width,
      height: row.height,
      rotation: row.rotation,
      anchorH: row.anchor_h,
      anchorV: row.anchor_v,
      sceneOrder: row.scene_order,
      cameraOrder: row.camera_order,
      visible: (row.visible as number) === 1,
      cameraNodePresetId: null,
    });
  }

  // Graphs owned by layers in the subtree
  const placeholders = layerIds.map(() => '?').join(',');
  const graphRows = db
    .prepare(
      `SELECT * FROM graphs WHERE owner_kind = 'compose_layer' AND owner_id IN (${placeholders}) ORDER BY created_at`
    )
    .all(...layerIds) as Record<string, unknown>[];

  const graphs = graphRows.map((g) => ({
    presetId: nextPresetId('g'),
    ownerKind: 'compose_layer' as const,
    ownerPresetId: realToPreset.get(g.owner_id as string) ?? '',
    name: g.name,
    enabled: (g.enabled as number) === 1,
    descriptor: JSON.parse((g.descriptor as string) || '{}'),
    nodeState: JSON.parse((g.node_state as string) || '{}'),
  }));

  // Track clips owned by layers
  const trackClipRows = db
    .prepare(
      `SELECT * FROM track_clips WHERE owner_kind = 'compose_layer' AND owner_id IN (${placeholders}) ORDER BY created_at`
    )
    .all(...layerIds) as Record<string, unknown>[];

  const trackClips = trackClipRows.map((tc) => {
    const lanes = db
      .prepare('SELECT * FROM track_clip_lanes WHERE clip_id = ?')
      .all(tc.id as string) as Record<string, unknown>[];
    return {
      presetId: nextPresetId('tc'),
      ownerKind: 'compose_layer' as const,
      ownerPresetId: realToPreset.get(tc.owner_id as string) ?? '',
      name: tc.name,
      duration: tc.duration,
      loop: (tc.loop as number) === 1,
      mode: tc.mode,
      autoplay: (tc.autoplay as number) === 1,
      lanes: lanes.map((lane) => {
        const kfs = db
          .prepare(
            'SELECT * FROM track_clip_keyframes WHERE lane_id = ? ORDER BY t'
          )
          .all(lane.id as string) as Record<string, unknown>[];
        return {
          presetId: nextPresetId('ln'),
          targetKind: lane.target_kind,
          targetPresetId:
            realToPreset.get(lane.target_id as string) ??
            (lane.target_id as string),
          paramPath: lane.param_path,
          defaultValue: lane.default_value ?? 0,
          keyframes: kfs.map((k) => ({
            presetId: nextPresetId('k'),
            t: k.t,
            value: k.value,
            easing: k.easing ?? 'linear',
            inHandleTFraction: k.in_handle_t_fraction ?? null,
            inHandleVFraction: k.in_handle_v_fraction ?? null,
            outHandleTFraction: k.out_handle_t_fraction ?? null,
            outHandleVFraction: k.out_handle_v_fraction ?? null,
          })),
        };
      }),
    };
  });

  const rootLayer = db
    .prepare(
      'SELECT project_id, root_compose_scene_id FROM compose_layers WHERE id = ?'
    )
    .get(rootId) as
    | { project_id: string; root_compose_scene_id: string | null }
    | undefined;

  return {
    format: 'vspark.preset.v2' as const,
    rootKind: 'compose_layer' as const,
    exportedAt: new Date().toISOString(),
    exportedFrom: {
      projectId: rootLayer?.project_id ?? '',
      rootComposeSceneId: rootLayer?.root_compose_scene_id ?? '',
      rootId,
    },
    assets,
    composeLayers,
    graphs: graphs.length > 0 ? graphs : undefined,
    trackClips: trackClips.length > 0 ? trackClips : undefined,
  };
}
