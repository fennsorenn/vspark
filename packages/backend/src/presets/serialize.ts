import { getDb } from '../db/index.js';
import {
  getSceneNodeDescendants,
  getComposeLayerDescendants,
} from './subtree.js';
import { hashFile, resolveAbsPath, fileToBase64 } from './assets.js';
import { makeExportSubstituter } from './substitute.js';

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

/** Serialize a clip's event/marker lane. `target_id` is remapped through the
 *  same realToPreset map used for lanes (so in-subtree targets round-trip);
 *  out-of-subtree targets survive verbatim and are caught by the substituter. */
function serializeClipEvents(
  db: ReturnType<typeof getDb>,
  clipId: string,
  realToPreset: Map<string, string>
): unknown[] {
  const rows = db
    .prepare('SELECT * FROM track_clip_events WHERE clip_id = ? ORDER BY t')
    .all(clipId) as Record<string, unknown>[];
  return rows.map((e) => {
    const evPresetId = nextPresetId('ev');
    realToPreset.set(e.id as string, evPresetId);
    return {
      presetId: evPresetId,
      t: e.t,
      action: e.action,
      targetKind: e.target_kind,
      targetPresetId:
        realToPreset.get(e.target_id as string) ?? (e.target_id as string),
      payload: e.payload ? JSON.parse(e.payload as string) : null,
    };
  });
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
        'SELECT * FROM behaviors WHERE node_id = ? ORDER BY sort_order'
      )
      .all(nid) as Record<string, unknown>[];

    const cameraEffects = db
      .prepare('SELECT * FROM camera_effects WHERE node_id = ?')
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
      // Spatial/kind-specific bag (transform, light, camera, billboard, …)
      // stored on the scene_nodes row. Previously dropped on round-trip.
      componentsBag: JSON.parse((row.components as string) || '{}'),
      components: components.map((c) => {
        const compPresetId = nextPresetId('c');
        realToPreset.set(c.id as string, compPresetId);
        return {
          presetId: compPresetId,
          kind: c.kind,
          enabled: (c.enabled as number) === 1,
          sortOrder: c.sort_order ?? 0,
          config: JSON.parse((c.config as string) || '{}'),
        };
      }),
      cameraEffects: cameraEffects.map((e) => {
        const effPresetId = nextPresetId('ce');
        realToPreset.set(e.id as string, effPresetId);
        return {
          presetId: effPresetId,
          kind: e.kind,
          enabled: (e.enabled as number) === 1,
          config: JSON.parse((e.config as string) || '{}'),
        };
      }),
    });
  }

  // Graphs owned by nodes in the subtree
  const placeholders = nodeIds.map(() => '?').join(',');
  const automationRows = db
    .prepare(
      `SELECT * FROM automations WHERE owner_kind = 'scene_node' AND owner_id IN (${placeholders}) ORDER BY created_at`
    )
    .all(...nodeIds) as Record<string, unknown>[];

  const graphs = automationRows.map((g) => {
    const automationPresetId = nextPresetId('g');
    realToPreset.set(g.id as string, automationPresetId);
    return {
      presetId: automationPresetId,
      ownerKind: 'scene_node' as const,
      ownerPresetId: realToPreset.get(g.owner_id as string) ?? '',
      name: g.name,
      enabled: (g.enabled as number) === 1,
      descriptor: JSON.parse((g.descriptor as string) || '{}'),
      nodeState: JSON.parse((g.node_state as string) || '{}'),
    };
  });

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
    const acPresetId = nextPresetId('ac');
    realToPreset.set(c.id as string, acPresetId);
    return {
      presetId: acPresetId,
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
      `SELECT * FROM track_clips WHERE owner_node_id IN (${placeholders}) ORDER BY created_at`
    )
    .all(...nodeIds) as Record<string, unknown>[];

  const trackClips = trackClipRows.map((tc) => {
    const lanes = db
      .prepare('SELECT * FROM track_clip_lanes WHERE clip_id = ?')
      .all(tc.id as string) as Record<string, unknown>[];
    const tcPresetId = nextPresetId('tc');
    realToPreset.set(tc.id as string, tcPresetId);
    return {
      presetId: tcPresetId,
      ownerKind: 'scene_node' as const,
      ownerPresetId: realToPreset.get(tc.owner_node_id as string) ?? '',
      name: tc.name,
      duration: tc.duration,
      loop: (tc.loop as number) === 1,
      mode: tc.mode,
      autoplay: (tc.autoplay as number) === 1,
      events: serializeClipEvents(db, tc.id as string, realToPreset),
      lanes: lanes.map((lane) => {
        const kfs = db
          .prepare(
            'SELECT * FROM track_clip_keyframes WHERE lane_id = ? ORDER BY t'
          )
          .all(lane.id as string) as Record<string, unknown>[];
        const targetPresetId =
          realToPreset.get(lane.target_id as string) ??
          (lane.target_id as string);
        const lnPresetId = nextPresetId('ln');
        realToPreset.set(lane.id as string, lnPresetId);
        return {
          presetId: lnPresetId,
          targetKind: lane.target_kind,
          targetPresetId,
          paramPath: lane.param_path,
          defaultValue: lane.default_value ?? 0,
          keyframes: kfs.map((k) => {
            const kPresetId = nextPresetId('k');
            realToPreset.set(k.id as string, kPresetId);
            return {
              presetId: kPresetId,
              t: k.t,
              value: k.value,
              easing: k.easing ?? 'linear',
              inHandleTFraction: k.in_handle_t_fraction ?? null,
              inHandleVFraction: k.in_handle_v_fraction ?? null,
              outHandleTFraction: k.out_handle_t_fraction ?? null,
              outHandleVFraction: k.out_handle_v_fraction ?? null,
            };
          }),
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

  // Final pass: rewrite any literal occurrence of a real id (anywhere in
  // nested JSON: descriptor body, layer.config, components[*].config,
  // properties, etc.) to its __preset:<tag> placeholder. Internal refs
  // round-trip cleanly; refs to entities outside the subtree (e.g. an
  // overlive account id) survive unchanged in the payload and get caught
  // by the runtime fallback / future external-ref picker on import. See
  // packages/backend/src/presets/substitute.ts.
  //
  // exportedFrom is excluded from substitution — it's audit-trail metadata
  // (never read on import) and replacing the source rootId with a
  // placeholder would be misleading.
  const substitute = makeExportSubstituter(realToPreset);
  return {
    format: 'vspark.preset.v2' as const,
    rootKind: 'scene_node' as const,
    exportedAt: new Date().toISOString(),
    exportedFrom: {
      projectId: rootNode?.project_id ?? '',
      rootSceneNodeId: rootNode?.root_scene_node_id ?? '',
      rootId,
    },
    assets: substitute(assets),
    sceneNodes: substitute(sceneNodes),
    graphs: graphs.length > 0 ? substitute(graphs) : undefined,
    animationClips:
      animationClips.length > 0 ? substitute(animationClips) : undefined,
    trackClips: trackClips.length > 0 ? substitute(trackClips) : undefined,
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
  const automationRows = db
    .prepare(
      `SELECT * FROM automations WHERE owner_kind = 'compose_layer' AND owner_id IN (${placeholders}) ORDER BY created_at`
    )
    .all(...layerIds) as Record<string, unknown>[];

  const graphs = automationRows.map((g) => {
    const automationPresetId = nextPresetId('g');
    realToPreset.set(g.id as string, automationPresetId);
    return {
      presetId: automationPresetId,
      ownerKind: 'compose_layer' as const,
      ownerPresetId: realToPreset.get(g.owner_id as string) ?? '',
      name: g.name,
      enabled: (g.enabled as number) === 1,
      descriptor: JSON.parse((g.descriptor as string) || '{}'),
      nodeState: JSON.parse((g.node_state as string) || '{}'),
    };
  });

  // Track clips owned by layers
  const trackClipRows = db
    .prepare(
      `SELECT * FROM track_clips WHERE owner_layer_id IN (${placeholders}) ORDER BY created_at`
    )
    .all(...layerIds) as Record<string, unknown>[];

  const trackClips = trackClipRows.map((tc) => {
    const lanes = db
      .prepare('SELECT * FROM track_clip_lanes WHERE clip_id = ?')
      .all(tc.id as string) as Record<string, unknown>[];
    const tcPresetId = nextPresetId('tc');
    realToPreset.set(tc.id as string, tcPresetId);
    return {
      presetId: tcPresetId,
      ownerKind: 'compose_layer' as const,
      ownerPresetId: realToPreset.get(tc.owner_layer_id as string) ?? '',
      name: tc.name,
      duration: tc.duration,
      loop: (tc.loop as number) === 1,
      mode: tc.mode,
      autoplay: (tc.autoplay as number) === 1,
      events: serializeClipEvents(db, tc.id as string, realToPreset),
      lanes: lanes.map((lane) => {
        const kfs = db
          .prepare(
            'SELECT * FROM track_clip_keyframes WHERE lane_id = ? ORDER BY t'
          )
          .all(lane.id as string) as Record<string, unknown>[];
        const lnPresetId = nextPresetId('ln');
        realToPreset.set(lane.id as string, lnPresetId);
        return {
          presetId: lnPresetId,
          targetKind: lane.target_kind,
          targetPresetId:
            realToPreset.get(lane.target_id as string) ??
            (lane.target_id as string),
          paramPath: lane.param_path,
          defaultValue: lane.default_value ?? 0,
          keyframes: kfs.map((k) => {
            const kPresetId = nextPresetId('k');
            realToPreset.set(k.id as string, kPresetId);
            return {
              presetId: kPresetId,
              t: k.t,
              value: k.value,
              easing: k.easing ?? 'linear',
              inHandleTFraction: k.in_handle_t_fraction ?? null,
              inHandleVFraction: k.in_handle_v_fraction ?? null,
              outHandleTFraction: k.out_handle_t_fraction ?? null,
              outHandleVFraction: k.out_handle_v_fraction ?? null,
            };
          }),
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

  const substitute = makeExportSubstituter(realToPreset);
  return {
    format: 'vspark.preset.v2' as const,
    rootKind: 'compose_layer' as const,
    exportedAt: new Date().toISOString(),
    exportedFrom: {
      projectId: rootLayer?.project_id ?? '',
      rootComposeSceneId: rootLayer?.root_compose_scene_id ?? '',
      rootId,
    },
    assets: substitute(assets),
    composeLayers: substitute(composeLayers),
    graphs: graphs.length > 0 ? substitute(graphs) : undefined,
    trackClips: trackClips.length > 0 ? substitute(trackClips) : undefined,
  };
}
