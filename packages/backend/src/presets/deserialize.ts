/**
 * Instantiating a preset — written THROUGH the mesh store.
 *
 * Every entity a preset creates is committed to its collection, and the
 * onCommitted tap persists it, emits `sync.document`, and runs the lifecycle
 * side effects (a behavior's signal graph, a logic graph's running instance).
 * This module used to INSERT the rows itself and then ask the route to emit
 * each one afterwards; that list omitted `logic`, so an imported preset's
 * graphs were invisible to every connected tab until it reloaded — the failure
 * mode a bypass of the store produces every time, just in a different rtype
 * each time.
 *
 * Order is not cosmetic: `persists` predicates gate a child on its parent's row
 * existing, so nodes and layers are committed before the behaviors, effects,
 * clips and graphs that hang off them. Each write's tap runs synchronously on
 * this peer (it is the authority), so awaiting the ack is enough to sequence
 * them.
 */
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { getMeshCollection } from '../mesh/index.js';
import { matchAssetByHash, materializeAsset } from './assets.js';
import { makeImportSubstituter } from './substitute.js';
import { byId } from '@vspark/shared/idMap';
import { keysBetween } from '@vspark/shared/fracIndex';

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
    order: number;
    visible: boolean;
    cameraNodePresetId: string | null;
  }>;
  logic?: Array<{
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

/** Commit one document and wait for it to be stored, or throw with the reason.
 *
 *  A rejection is the collection refusing the document (an unrunnable graph
 *  descriptor, a failed guard) — the same 400 the caller would have got from
 *  the equivalent REST route, rather than a half-imported preset. */
async function commit(
  rtype: string,
  id: string,
  doc: Record<string, unknown>
): Promise<void> {
  const col = getMeshCollection(rtype);
  if (!col) throw new Error(`store not ready (${rtype})`);
  const outcome = await col.set(id, '', doc).ack;
  if (outcome.status === 'rejected')
    throw new Error(`${rtype} ${id} rejected: ${outcome.reason}`);
}

export async function instantiatePreset(
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
): Promise<InstantiateResult> {
  const db = getDb();
  const idMap: Record<string, string> = {};
  const missingAssets: string[] = [];

  // Pre-mint a real id for every entity in the payload, then substitute
  // `__preset:<tag>` tokens inside any nested JSON blob (descriptors,
  // configs, properties) with the corresponding real id BEFORE committing.
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
  for (const g of payloadInput.logic ?? []) {
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

  // These two just read the pre-built map. They stay because the write code
  // below resolves parent / owner / target refs that live in TOP-LEVEL fields,
  // which the substituter does not touch (it rewrites tokens inside nested JSON
  // blobs).
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

      // The node before the things attached to it: a behavior or effect whose
      // node has no row yet is treated as a projection and never persisted.
      await commit('scene_node', realId, {
        id: realId,
        projectId: target.projectId,
        rootSceneNodeId: target.rootSceneNodeId ?? '',
        parentId,
        boneAttachment,
        name: node.name,
        kind: node.kind,
        filePath,
        components: node.componentsBag ?? {},
        properties: node.properties,
        hidden: node.hidden,
      });

      for (const comp of node.components) {
        const compId = mintId(comp.presetId);
        await commit('behavior', compId, {
          id: compId,
          nodeId: realId,
          kind: comp.kind,
          enabled: comp.enabled,
          config: comp.config,
          sortOrder: comp.sortOrder,
        });
      }

      for (const eff of node.cameraEffects ?? []) {
        const effId = mintId(eff.presetId);
        await commit('camera_effect', effId, {
          id: effId,
          nodeId: realId,
          kind: eff.kind,
          enabled: eff.enabled,
          config: eff.config,
        });
      }
    }

    for (const clip of payload.animationClips ?? []) {
      const clipId = mintId(clip.presetId);
      const sourceNodeId = resolveId(clip.sourceNodePresetId);
      const sourceFilePath = clip.sourceFilePresetAssetId
        ? (assetMap.get(clip.sourceFilePresetAssetId)?.filePath ?? '')
        : '';
      await commit('animation_clip', clipId, {
        id: clipId,
        name: clip.label,
        sourceNodeId,
        sourceFilePath,
        clipIndex: clip.clipIndex,
        label: clip.label,
        startTime: clip.startTime,
        endTime: clip.endTime,
        duration: clip.duration,
        fps: clip.fps,
      });
    }
  }

  if (payload.rootKind === 'compose_layer' && payload.composeLayers) {
    // Presets carry relative order only. Generate real keys against the target:
    // top-level preset layers join an existing sibling group (so they land in
    // FRONT of what's already there), while nested ones hang off a parent this
    // preset is creating, whose group starts empty.
    const orderKeys = new Map<string, string>();
    {
      const byParent = new Map<string | null, typeof payload.composeLayers>();
      for (const l of payload.composeLayers) {
        const k = l.parentPresetId ?? null;
        const g = byParent.get(k);
        if (g) g.push(l);
        else byParent.set(k, [l]);
      }
      for (const [parentPresetId, group] of byParent) {
        group.sort((a, b) => a.order - b.order);
        const after =
          parentPresetId === null
            ? ((
                db
                  .prepare(
                    `SELECT MAX(order_key) AS k FROM compose_layers
                      WHERE root_compose_scene_id IS ? AND parent_id IS ?`
                  )
                  .get(
                    target.rootComposeSceneId ?? null,
                    target.parentId ?? null
                  ) as { k: string | null } | undefined
              )?.k ?? null)
            : null;
        const keys = keysBetween(after, null, group.length);
        group.forEach((l, i) => orderKeys.set(l.presetId, keys[i]));
      }
    }

    for (const layer of payload.composeLayers) {
      const realId = mintId(layer.presetId);
      if (!rootId) rootId = realId;

      const parentId = layer.parentPresetId
        ? resolveId(layer.parentPresetId)
        : (target.parentId ?? null);

      const assetId = layer.assetPresetAssetId
        ? (assetMap.get(layer.assetPresetAssetId)?.assetFileId ?? null)
        : null;

      await commit('compose_layer', realId, {
        id: realId,
        projectId: target.projectId,
        rootComposeSceneId: target.rootComposeSceneId ?? null,
        cameraNodeId: null,
        parentId,
        name: layer.name,
        kind: layer.kind,
        assetId,
        config: layer.config,
        x: layer.x,
        y: layer.y,
        width: layer.width,
        height: layer.height,
        rotation: layer.rotation,
        anchorH: layer.anchorH,
        anchorV: layer.anchorV,
        orderKey: orderKeys.get(layer.presetId) ?? '',
        visible: layer.visible,
      });
    }
  }

  // Committing a graph starts it: the tap reconciles the running instance, so
  // an enabled imported graph fires without waiting for a restart. The
  // descriptor is checked by the collection's guard, and a preset carrying an
  // unrunnable one fails the import rather than persisting a broken program.
  for (const graph of payload.logic ?? []) {
    const graphId = mintId(graph.presetId);
    await commit('logic', graphId, {
      id: graphId,
      ownerKind: graph.ownerKind,
      ownerId: resolveId(graph.ownerPresetId),
      name: graph.name,
      enabled: graph.enabled,
      descriptor: graph.descriptor,
    });
    // `node_state` is runtime scratch owned by the running graph, not document
    // content — the logic DTO leaves it out on purpose (sync/resources.ts), so
    // a preset that carries it restores it on the row directly. This is not a
    // write the store should be carrying: nothing replicates it, and the
    // running instance overwrites it as it goes.
    db.prepare('UPDATE logic SET node_state = ? WHERE id = ?').run(
      JSON.stringify(graph.nodeState ?? {}),
      graphId
    );
  }

  // A clip is ONE document: its lanes, keyframes and events are keyed children
  // of the aggregate (@vspark/shared/idMap), not rows to be written separately.
  // So the whole clip goes in a single commit and the tap writes the three
  // tables from it.
  for (const tc of payload.trackClips ?? []) {
    const clipId = mintId(tc.presetId);
    const ownerId = resolveId(tc.ownerPresetId);
    await commit('track_clip', clipId, {
      id: clipId,
      ownerNodeId: tc.ownerKind === 'scene_node' ? ownerId : null,
      ownerLayerId: tc.ownerKind === 'compose_layer' ? ownerId : null,
      name: tc.name,
      duration: tc.duration,
      loop: tc.loop,
      mode: tc.mode,
      autoplay: tc.autoplay,
      lanes: byId(
        tc.lanes.map((lane) => ({
          id: mintId(lane.presetId),
          clipId,
          targetKind: lane.targetKind,
          targetId: resolveId(lane.targetPresetId),
          paramPath: lane.paramPath,
          defaultValue: lane.defaultValue,
          keyframes: byId(
            lane.keyframes.map((kf) => ({
              id: mintId(kf.presetId),
              t: kf.t,
              value: kf.value,
              easing: kf.easing,
              inHandleTFraction: kf.inHandleTFraction,
              inHandleVFraction: kf.inHandleVFraction,
              outHandleTFraction: kf.outHandleTFraction,
              outHandleVFraction: kf.outHandleVFraction,
            }))
          ),
        }))
      ),
      events: byId(
        (tc.events ?? []).map((ev) => ({
          id: mintId(ev.presetId),
          t: ev.t,
          action: ev.action,
          targetKind: ev.targetKind,
          targetId: resolveId(ev.targetPresetId),
          payload: ev.payload ?? null,
        }))
      ),
    });
  }

  return { rootId, idMap, missingAssets };
}
