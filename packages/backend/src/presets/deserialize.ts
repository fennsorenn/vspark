import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { matchAssetByHash, materializeAsset } from './assets.js';
import { makeImportSubstituter } from './substitute.js';
import { automationManager } from '../project_graphs/manager.js';

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
    /** Spatial/kind-specific bag (transform, light, camera, …). Optional for
     *  backward compatibility with payloads serialized before this field. */
    componentsBag?: Record<string, unknown>;
    components: Array<{
      presetId: string;
      kind: string;
      enabled: boolean;
      sortOrder: number;
      config: Record<string, unknown>;
    }>;
    cameraEffects?: Array<{
      presetId: string;
      kind: string;
      enabled: boolean;
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
    events?: Array<{
      presetId: string;
      t: number;
      action: string;
      targetKind: string;
      targetPresetId: string;
      payload: Record<string, unknown> | null;
    }>;
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
  payloadInput: PresetPayload,
  target: {
    projectId: string;
    rootSceneNodeId?: string;
    rootComposeSceneId?: string;
    parentId?: string | null;
    /** When set, the inserted root scene node gets bone_attachment = this
     *  bone name. Used for the "Paste scene node onto a bone" UX, where
     *  the user right-clicks a bone in the avatar tree to attach the
     *  pasted node to that bone on the host avatar. Only meaningful when
     *  rootKind = 'scene_node' and parentId is the avatar node's id. */
    boneAttachment?: string | null;
  }
): InstantiateResult {
  const db = getDb();
  const idMap: Record<string, string> = {};
  const missingAssets: string[] = [];

  // Pre-mint a real id for every entity in the payload, then substitute
  // `__preset:<tag>` tokens inside any nested JSON blob (descriptors,
  // configs, properties) with the corresponding real id BEFORE inserting.
  // This is what makes graph descriptors with embedded clip/node ids
  // round-trip across projects. See packages/backend/src/presets/substitute.ts.
  const presetToReal = new Map<string, string>();
  function premint(presetId: string): void {
    if (!presetToReal.has(presetId)) {
      const real = randomUUID();
      presetToReal.set(presetId, real);
      idMap[presetId] = real;
    }
  }
  for (const n of payloadInput.sceneNodes ?? []) {
    premint(n.presetId);
    for (const c of n.components) premint(c.presetId);
    for (const e of n.cameraEffects ?? []) premint(e.presetId);
  }
  for (const l of payloadInput.composeLayers ?? []) {
    premint(l.presetId);
  }
  for (const g of payloadInput.graphs ?? []) {
    premint(g.presetId);
  }
  for (const ac of payloadInput.animationClips ?? []) {
    premint(ac.presetId);
  }
  for (const tc of payloadInput.trackClips ?? []) {
    premint(tc.presetId);
    for (const ev of tc.events ?? []) premint(ev.presetId);
    for (const lane of tc.lanes) {
      premint(lane.presetId);
      for (const kf of lane.keyframes) premint(kf.presetId);
    }
  }

  // Now rewrite every `__preset:<tag>` token in nested JSON to its real id.
  const substituted = makeImportSubstituter(presetToReal)(payloadInput);
  const payload = substituted as PresetPayload;

  // Existing helpers now just read from the pre-built map. We keep them
  // around so the existing insert code (which calls resolveId for parent /
  // owner / target refs in top-level fields) keeps working unchanged.
  function mintId(presetId: string): string {
    // Idempotent: returns the pre-minted id if present, else a fresh one
    // (defensive — every preset id we encounter should have been pre-minted
    // already given the loops above).
    if (!idMap[presetId]) {
      const real = randomUUID();
      idMap[presetId] = real;
      presetToReal.set(presetId, real);
    }
    return idMap[presetId];
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
      const isRoot = !rootId;
      if (isRoot) rootId = realId;

      const parentId = node.parentPresetId
        ? resolveId(node.parentPresetId)
        : (target.parentId ?? null);

      // For the root scene node, target.boneAttachment overrides the
      // per-node value — that's the "paste this node onto this bone"
      // path. Descendants keep their own bone_attachment values intact.
      const boneAttachment = isRoot
        ? (target.boneAttachment ?? node.boneAttachment)
        : node.boneAttachment;

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
        boneAttachment,
        node.name,
        node.kind,
        filePath,
        JSON.stringify(node.componentsBag ?? {}),
        JSON.stringify(node.properties),
        node.hidden ? 1 : 0
      );

      // Insert components
      for (const comp of node.components) {
        const compId = mintId(comp.presetId);
        db.prepare(
          `INSERT INTO behaviors (id, node_id, kind, enabled, config, sort_order)
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

      // Insert camera effects
      for (const eff of node.cameraEffects ?? []) {
        const effId = mintId(eff.presetId);
        db.prepare(
          `INSERT INTO camera_effects (id, node_id, kind, enabled, config)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          effId,
          realId,
          eff.kind,
          eff.enabled ? 1 : 0,
          JSON.stringify(eff.config)
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

  // Insert graphs + reconcile so enabled standalone graphs start running
  // immediately (parity with POST /scene-nodes/:nodeId/graphs and
  // POST /compose-layers/:layerId/graphs).
  const insertedGraphIds: string[] = [];
  for (const graph of payload.graphs ?? []) {
    const graphId = mintId(graph.presetId);
    const ownerId = resolveId(graph.ownerPresetId);
    db.prepare(
      `INSERT INTO automations (id, owner_kind, owner_id, name, enabled, descriptor, node_state)
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
    insertedGraphIds.push(graphId);
  }

  // Insert track clips
  for (const tc of payload.trackClips ?? []) {
    const clipId = mintId(tc.presetId);
    const ownerId = resolveId(tc.ownerPresetId);
    const ownerNodeId = tc.ownerKind === 'scene_node' ? ownerId : null;
    const ownerLayerId = tc.ownerKind === 'compose_layer' ? ownerId : null;
    db.prepare(
      `INSERT INTO track_clips (id, owner_node_id, owner_layer_id, name, duration, loop, mode, autoplay)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      clipId,
      ownerNodeId,
      ownerLayerId,
      tc.name,
      tc.duration,
      tc.loop ? 1 : 0,
      tc.mode,
      tc.autoplay ? 1 : 0
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

    for (const ev of tc.events ?? []) {
      const evId = mintId(ev.presetId);
      const targetId = resolveId(ev.targetPresetId);
      db.prepare(
        `INSERT INTO track_clip_events (id, clip_id, t, action, target_kind, target_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        evId,
        clipId,
        ev.t,
        ev.action,
        ev.targetKind,
        targetId,
        ev.payload ? JSON.stringify(ev.payload) : null
      );
    }
  }

  // Start any enabled standalone graphs we just inserted. Without this they
  // sit in the DB but never instantiate (their nodes don't fire) until the
  // next server restart, which would silently break preset-bundled graphs.
  for (const gid of insertedGraphIds) {
    try {
      automationManager.reconcile(gid);
    } catch (e) {
      console.warn(`[preset] failed to start imported graph ${gid}:`, e);
    }
  }

  return { rootId, idMap, missingAssets };
}
