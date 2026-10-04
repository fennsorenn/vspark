import * as THREE from 'three';
import { useEditorStore } from './store/editorStore';
import type { ComposeLayerRecord } from './api/client';
import { getPath, type MeshPeer } from '@vspark/mesh';
import { collectionOf } from './mesh/docs';
import { applyNodePreview, transformFieldsOf } from './sync/nodePreview';

/**
 * Smooths incoming live-preview updates from other clients so they glide
 * between samples instead of snapping. A new preview retargets the tween's
 * `to` and re-baselines `from` to the currently displayed value, so retargeting
 * mid-tween feels seamless.
 *
 * Only used for *received* updates. The sender's own drag/wheel writes go to
 * the store directly — they're authoritative for the local user.
 *
 * Scalar fields use per-field linear tweens. Node rotations are tweened as a
 * single quaternion (slerp) to avoid gimbal-style discontinuities when
 * crossing ±90° on the Y axis (where independent X/Z lerp would flip wildly).
 */

const SMOOTH_MS = 80; // tween window per sample (~2.5 preview intervals at 30 Hz)

type Scope = 'node' | 'layer';

interface ScalarTween {
  scope: Scope;
  id: string;
  field: string;
  from: number;
  to: number;
  startedAt: number;
}

interface QuatTween {
  nodeId: string;
  from: THREE.Quaternion;
  to: THREE.Quaternion;
  startedAt: number;
}

const scalarTweens = new Map<string, ScalarTween>();
const quatTweens = new Map<string, QuatTween>(); // keyed by nodeId
let rafHandle: number | null = null;

function scalarKey(scope: Scope, id: string, field: string): string {
  return `${scope}:${id}:${field}`;
}

function eulerFromTransform(
  t: Record<string, number> | undefined
): THREE.Euler {
  return new THREE.Euler(t?.rx ?? 0, t?.ry ?? 0, t?.rz ?? 0, 'XYZ');
}

function ensureLoop() {
  if (rafHandle != null) return;
  const tick = () => {
    rafHandle = null;
    const now = performance.now();
    if (scalarTweens.size === 0 && quatTweens.size === 0) return;

    // Group field updates per (scope, id).
    const nodePatches = new Map<string, Record<string, number>>();
    const layerPatches = new Map<string, Record<string, number>>();

    // Scalar tweens.
    for (const [k, t] of scalarTweens) {
      const p = Math.min(1, (now - t.startedAt) / SMOOTH_MS);
      const v = t.from + (t.to - t.from) * p;
      if (t.scope === 'node') {
        let m = nodePatches.get(t.id);
        if (!m) {
          m = {};
          nodePatches.set(t.id, m);
        }
        m[t.field] = v;
      } else {
        let m = layerPatches.get(t.id);
        if (!m) {
          m = {};
          layerPatches.set(t.id, m);
        }
        m[t.field] = v;
      }
      if (p >= 1) scalarTweens.delete(k);
    }

    // Quaternion tweens (node rotation only).
    const quatBuf = new THREE.Quaternion();
    const eulerBuf = new THREE.Euler();
    for (const [nodeId, q] of quatTweens) {
      const p = Math.min(1, (now - q.startedAt) / SMOOTH_MS);
      quatBuf.copy(q.from).slerp(q.to, p);
      eulerBuf.setFromQuaternion(quatBuf, 'XYZ');
      let m = nodePatches.get(nodeId);
      if (!m) {
        m = {};
        nodePatches.set(nodeId, m);
      }
      m.rx = eulerBuf.x;
      m.ry = eulerBuf.y;
      m.rz = eulerBuf.z;
      if (p >= 1) quatTweens.delete(nodeId);
    }

    const store = useEditorStore.getState();
    // Same for a node: its tween shows through `liveNodes` until it ends.
    for (const [nodeId, fields] of nodePatches)
      store.setLiveNode(nodeId, hasNodeTween(nodeId) ? fields : null);
    // A layer's tween shows through `liveLayers` until it ends; then the
    // document — which already holds the target — shows on its own.
    const tweening = new Set<string>();
    for (const t of scalarTweens.values())
      if (t.scope === 'layer') tweening.add(t.id);
    for (const [layerId, fields] of layerPatches)
      store.setLiveLayer(
        layerId,
        tweening.has(layerId) ? (fields as Partial<ComposeLayerRecord>) : null
      );

    if (scalarTweens.size > 0 || quatTweens.size > 0)
      rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);
}

/** Whether a tween is currently animating this layer.
 *
 *  The mesh feeder uses this to decide how a COMMITTED value should land: mid
 *  gesture it retargets the running tween so the layer glides into its final
 *  position, but a value arriving cold (page load, a remote panel edit) applies
 *  immediately rather than animating in from wherever the store happened to be. */
export function hasLayerTween(id: string): boolean {
  for (const t of scalarTweens.values())
    if (t.scope === 'layer' && t.id === id) return true;
  return false;
}

/** Whether a tween is currently animating this node. Same job as
 *  {@link hasLayerTween}, but it must check BOTH maps: node position and scale
 *  are scalar tweens, while rotation is only ever a quaternion tween (see
 *  `retargetQuat`). A layer-style scan of `scalarTweens` alone would report "no
 *  tween" for a rotate-only drag, so the committed value would snap the node
 *  instead of gliding it in. */
export function hasNodeTween(id: string): boolean {
  if (quatTweens.has(id)) return true;
  for (const t of scalarTweens.values())
    if (t.scope === 'node' && t.id === id) return true;
  return false;
}

/** Retarget a scalar tween, re-baselining from the current displayed value. */
function retargetScalar(
  scope: Scope,
  id: string,
  field: string,
  to: number,
  currentValue: number,
  isAngleRad = false
) {
  let from = currentValue;
  if (isAngleRad) {
    // Shortest-arc on a per-axis basis. Only meaningful when we're NOT using
    // a quaternion tween (e.g. layer rotation in degrees has no quaternion path).
    let d = to - from;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d <= -Math.PI) d += 2 * Math.PI;
    to = from + d;
  }
  scalarTweens.set(scalarKey(scope, id, field), {
    scope,
    id,
    field,
    from,
    to,
    startedAt: performance.now(),
  });
  ensureLoop();
}

function retargetScalarDeg(
  scope: Scope,
  id: string,
  field: string,
  to: number,
  currentValue: number
) {
  let from = currentValue;
  let d = to - from;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  to = from + d;
  scalarTweens.set(scalarKey(scope, id, field), {
    scope,
    id,
    field,
    from,
    to,
    startedAt: performance.now(),
  });
  ensureLoop();
}

/** Retarget the node's rotation as a slerp from current → target quaternion. */
function retargetQuat(
  nodeId: string,
  currentEuler: THREE.Euler,
  targetEuler: THREE.Euler
) {
  const from = new THREE.Quaternion().setFromEuler(currentEuler);
  const to = new THREE.Quaternion().setFromEuler(targetEuler);
  // Ensure shortest arc (slerp does this when dot < 0; setFromEuler always
  // produces a valid quaternion, so this is just defensive).
  if (from.dot(to) < 0) to.set(-to.x, -to.y, -to.z, -to.w);
  quatTweens.set(nodeId, { nodeId, from, to, startedAt: performance.now() });
  ensureLoop();
}

// ── Public API ───────────────────────────────────────────────────────────────

/** What this tab shows for a node's transform: a running tween's values over
 *  the committed transform (a received overlay already holds the target). */
function shownTransform(nodeId: string): Record<string, number> | undefined {
  const raw = collectionOf<{ components?: Record<string, unknown> }>(
    'scene_node'
  ).replica.raw(nodeId);
  if (!raw) return undefined;
  const committed = raw.components?.transform as
    | Record<string, number>
    | undefined;
  const live = useEditorStore.getState().liveNodes[nodeId];
  return live ? { ...committed, ...live } : committed;
}

/** Smooth an incoming node transform preview. Position/scale fields tween per
 *  axis; rotation tweens as a single quaternion to dodge Euler gimbal flips.
 *  Other fields (opacity, shadow flags) show as they arrive — the document
 *  already carries them. */
export function smoothNodeTransform(
  nodeId: string,
  transform: Record<string, number>
) {
  const cur = shownTransform(nodeId);
  if (!cur) return;

  // Scalars first (position + scale).
  const scalarFields = ['x', 'y', 'z', 'sx', 'sy', 'sz'];
  for (const f of scalarFields) {
    const to = transform[f];
    if (typeof to !== 'number') continue;
    retargetScalar('node', nodeId, f, to, cur[f] ?? to);
  }

  // Rotation: if any of rx/ry/rz is present, target the full rotation as a
  // quaternion. Missing axes fall back to the current value so partial updates
  // still produce a coherent quaternion target.
  if ('rx' in transform || 'ry' in transform || 'rz' in transform) {
    const target = new THREE.Euler(
      typeof transform.rx === 'number' ? transform.rx : (cur.rx ?? 0),
      typeof transform.ry === 'number' ? transform.ry : (cur.ry ?? 0),
      typeof transform.rz === 'number' ? transform.rz : (cur.rz ?? 0),
      'XYZ'
    );
    // Re-baseline from the currently displayed orientation so retargeting
    // mid-slerp is seamless.
    retargetQuat(nodeId, eulerFromTransform(cur), target);
  }
}

/** Smooth an incoming compose-layer preview patch (x/y/width/height/rotation).
 *  Other fields show as they arrive (the document already carries them). Layer
 *  rotation is 2D (degrees, single axis) so a scalar shortest-arc tween is
 *  enough. The tween starts from what this tab currently shows: a running
 *  tween's value, else the committed one (the overlay already holds the
 *  target). */
export function smoothComposeLayer(id: string, patch: Record<string, unknown>) {
  const shown = useEditorStore.getState().liveLayers[id] as
    | Record<string, number>
    | undefined;
  const committed =
    collectionOf<Record<string, number>>('compose_layer').replica.raw(id);
  if (!committed) return;
  const from = (field: string, to: number) =>
    shown?.[field] ?? committed[field] ?? to;
  const linearFields = new Set(['x', 'y', 'width', 'height']);
  for (const [field, to] of Object.entries(patch)) {
    if (typeof to !== 'number') continue;
    if (linearFields.has(field))
      retargetScalar('layer', id, field, to, from(field, to));
    else if (field === 'rotation')
      retargetScalarDeg('layer', id, field, to, from(field, to));
  }
}

/** Tween compose layers that another tab is dragging (the lossy `preview`
 *  channel), so they glide between samples. Mid-gesture, a committed value
 *  retargets the running tween so the layer glides into its final position
 *  instead of snapping (the last preview may never have landed). */
export function startPreviewSmoothing(peer: MeshPeer): () => void {
  const offLayers = peer
    .collection<Record<string, unknown>>('compose_layer')
    .observe('**', (c) => {
      if (c.origin === peer.id || !c.doc) return;
      if (c.op === 'ephemeral')
        smoothComposeLayer(
          c.id,
          c.path ? { [c.path]: getPath(c.doc, c.path) } : c.doc
        );
      else if (hasLayerTween(c.id)) smoothComposeLayer(c.id, c.doc);
    });
  const offNodes = peer
    .collection<Record<string, unknown>>('scene_node')
    .observe('**', (c) => {
      if (c.origin === peer.id || !c.doc) return;
      if (c.op === 'ephemeral') applyNodePreview(c.id, c.doc, c.path);
      else if (hasNodeTween(c.id)) {
        const t = transformFieldsOf(c.doc);
        if (t) smoothNodeTransform(c.id, t);
      }
    });
  return () => {
    offLayers();
    offNodes();
  };
}
