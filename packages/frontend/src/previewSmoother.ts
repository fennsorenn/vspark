import * as THREE from 'three';
import { useEditorStore } from './store/editorStore';
import type { ComposeLayerRecord } from './api/client';
import { getPath, type MeshPeer } from '@vspark/mesh';
import { collectionOf } from './mesh/docs';
import { applyNodePreview, transformFieldsOf } from './sync/nodePreview';

/**
 * Smooths incoming live-preview updates from other clients so they glide
 * between samples instead of snapping.
 *
 * Only used for *received* updates. The sender's own drag/wheel writes go to
 * the store directly — they're authoritative for the local user.
 *
 * **Nodes play back from a short buffer.** Samples arrive unevenly — ~33ms
 * apart from the sender, but 10ms apart one moment and 100ms the next after the
 * network and the server. Restarting a tween at each sample made the speed
 * jump with every arrival and stop in every long gap (a choppy drag in the
 * other tab, measured 2026-10-04). Instead each node keeps its recent samples,
 * evened out in time, and shows the motion `playbackDelay()` behind them,
 * interpolating between the two samples around that moment: a steady speed at
 * the cost of ~100ms of latency. Rotation interpolates as a quaternion (slerp,
 * shortest arc) to avoid gimbal flips.
 *
 * Compose layers keep the per-sample tween: they retarget a linear tween from
 * the displayed value at each sample.
 */

const SMOOTH_MS = 80; // layer tween window per sample (~2.5 intervals at 30 Hz)

type Scope = 'node' | 'layer';

interface ScalarTween {
  scope: Scope;
  id: string;
  field: string;
  from: number;
  to: number;
  startedAt: number;
}

const scalarTweens = new Map<string, ScalarTween>();
let rafHandle: number | null = null;

// --- node playback buffer ------------------------------------------------------

const POS_FIELDS = ['x', 'y', 'z', 'sx', 'sy', 'sz'] as const;
const POS_DEFAULT: Record<string, number> = {
  x: 0,
  y: 0,
  z: 0,
  sx: 1,
  sy: 1,
  sz: 1,
};
/** Field ops of one gesture sample arrive back to back (one per field). */
const SAME_SAMPLE_MS = 6;

interface NodeSample {
  /** When to show it, on this tab's clock (arrival, evened out). */
  t: number;
  pos: Record<string, number>;
  q: THREE.Quaternion;
}

interface NodeTrack {
  samples: NodeSample[];
  /** Arrival of the newest sample, unadjusted. */
  lastArrival: number;
  /** Running estimate of the time between samples. */
  interval: number;
}

const nodeTracks = new Map<string, NodeTrack>();

/** How far behind the newest samples a node is shown: enough to bridge an
 *  occasional late sample, not much more. */
function playbackDelay(track: NodeTrack): number {
  return Math.min(160, Math.max(60, track.interval * 2.5));
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/** The node's transform at `time` on its track. */
function sampleAt(track: NodeTrack, time: number): Record<string, number> {
  const s = track.samples;
  let i = 0;
  while (i < s.length - 1 && s[i + 1].t <= time) i++;
  const a = s[i];
  const b = s[i + 1];
  const out: Record<string, number> = {};
  const q = new THREE.Quaternion();
  if (!b || time <= a.t) {
    Object.assign(out, a.pos);
    q.copy(a.q);
  } else {
    const k = (time - a.t) / (b.t - a.t);
    for (const f of POS_FIELDS) out[f] = lerp(a.pos[f], b.pos[f], k);
    q.copy(a.q).slerp(b.q, k);
  }
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  out.rx = e.x;
  out.ry = e.y;
  out.rz = e.z;
  return out;
}

/** Advance every node track to `now`: the patch each shows, and drop tracks
 *  that have played out their last sample. */
function playNodeTracks(now: number): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const [id, track] of nodeTracks) {
    const time = now - playbackDelay(track);
    out.set(id, sampleAt(track, time));
    // Keep one sample at or before `time` to interpolate from.
    while (track.samples.length > 2 && track.samples[1].t <= time)
      track.samples.shift();
    const last = track.samples[track.samples.length - 1];
    if (time >= last.t) nodeTracks.delete(id);
  }
  return out;
}

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
    if (scalarTweens.size === 0 && nodeTracks.size === 0) return;

    const nodePatches = playNodeTracks(now);
    const layerPatches = new Map<string, Record<string, number>>();

    // Layer tweens.
    for (const [k, t] of scalarTweens) {
      const p = Math.min(1, (now - t.startedAt) / SMOOTH_MS);
      const v = t.from + (t.to - t.from) * p;
      let m = layerPatches.get(t.id);
      if (!m) {
        m = {};
        layerPatches.set(t.id, m);
      }
      m[t.field] = v;
      if (p >= 1) scalarTweens.delete(k);
    }

    const store = useEditorStore.getState();
    // A node's tween shows through `liveNodes`, and its last values stay there
    // until a committed transform replaces them (see startPreviewSmoothing):
    // node lists skip transform previews, so the document underneath still
    // holds the last committed position, not the preview's.
    for (const [nodeId, fields] of nodePatches)
      store.setLiveNode(nodeId, fields);
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

    if (scalarTweens.size > 0 || nodeTracks.size > 0)
      rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);
}

/** Whether a tween is currently animating this layer.
 *
 *  The commit observer below uses this to decide how a COMMITTED value lands: mid
 *  gesture it retargets the running tween so the layer glides into its final
 *  position, but a value arriving cold (page load, a remote panel edit) applies
 *  immediately rather than animating in from wherever the live slice happened to be. */
export function hasLayerTween(id: string): boolean {
  for (const t of scalarTweens.values())
    if (t.scope === 'layer' && t.id === id) return true;
  return false;
}

/** Whether this node is playing back another tab's gesture (any field,
 *  rotation included). Same job as {@link hasLayerTween}: mid-gesture a
 *  committed value joins the playback as its last sample, so the node glides
 *  into its final pose instead of snapping. */
export function hasNodeTween(id: string): boolean {
  return nodeTracks.has(id);
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

// ── Public API ───────────────────────────────────────────────────────────────

/** What this tab shows for a node's transform: a running tween's values over
 *  the committed transform (a received overlay already holds the target). */
function shownTransform(nodeId: string): Record<string, number> | undefined {
  const raw = collectionOf<{ components?: Record<string, unknown> }>(
    'scene_node'
  ).replica.raw(nodeId);
  if (!raw) return undefined;
  // A node created without a transform has none committed yet: start from the
  // defaults (callers fall back to the target per missing field).
  const committed = (raw.components?.transform ?? {}) as Record<string, number>;
  const live = useEditorStore.getState().liveNodes[nodeId];
  return live ? { ...committed, ...live } : committed;
}

/** Feed an incoming node transform preview (any subset of x/y/z, rx/ry/rz,
 *  sx/sy/sz) into the node's playback buffer. Fields it leaves out keep their
 *  previous value. Other fields (opacity, shadow flags) show as they arrive —
 *  the document already carries them. */
export function smoothNodeTransform(
  nodeId: string,
  transform: Record<string, number>
) {
  const now = performance.now();
  let track = nodeTracks.get(nodeId);
  if (!track) {
    const cur = shownTransform(nodeId);
    if (!cur) return;
    // Start from what this tab shows now, so playback begins without a jump.
    const pos: Record<string, number> = {};
    for (const f of POS_FIELDS) pos[f] = cur[f] ?? POS_DEFAULT[f];
    track = {
      samples: [
        {
          t: now,
          pos,
          q: new THREE.Quaternion().setFromEuler(eulerFromTransform(cur)),
        },
      ],
      lastArrival: now,
      interval: 33,
    };
    nodeTracks.set(nodeId, track);
  }
  const prev = track.samples[track.samples.length - 1];
  const sameSample =
    track.samples.length > 1 && now - track.lastArrival < SAME_SAMPLE_MS;
  const next: NodeSample = sameSample
    ? prev
    : { t: 0, pos: { ...prev.pos }, q: prev.q.clone() };
  for (const f of POS_FIELDS)
    if (typeof transform[f] === 'number') next.pos[f] = transform[f];
  if ('rx' in transform || 'ry' in transform || 'rz' in transform) {
    const e = new THREE.Euler().setFromQuaternion(next.q, 'XYZ');
    next.q.setFromEuler(
      new THREE.Euler(
        typeof transform.rx === 'number' ? transform.rx : e.x,
        typeof transform.ry === 'number' ? transform.ry : e.y,
        typeof transform.rz === 'number' ? transform.rz : e.z,
        'XYZ'
      )
    );
  }
  if (!sameSample) {
    const gap = now - track.lastArrival;
    if (track.samples.length > 1)
      track.interval =
        track.interval * 0.8 + Math.min(200, Math.max(8, gap)) * 0.2;
    // Even out arrival times: show a sample between half an interval and one
    // and a half after the previous one, as close to its arrival as that
    // allows. A bunched sample is spread out, a late one is pulled in; the
    // playback delay leaves room for both, and the timeline catches up with
    // the arrivals within a few samples.
    next.t = Math.max(
      prev.t + track.interval * 0.5,
      Math.min(now, prev.t + track.interval * 1.5)
    );
    track.samples.push(next);
    track.lastArrival = now;
  }
  ensureLoop();
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

/** Does a committed write at `path` (undefined = whole document) set the
 *  node's transform? */
function touchesTransform(path: string | undefined): boolean {
  return (
    !path ||
    'components.transform'.startsWith(path) ||
    path.startsWith('components.transform.')
  );
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
      if (!c.doc) return;
      const own = c.origin === peer.id;
      if (c.op === 'ephemeral') {
        if (!own) applyNodePreview(c.id, c.doc, c.path);
        return;
      }
      if (!touchesTransform(c.path)) return;
      // Another tab's commit mid-tween: glide into it.
      if (!own && hasNodeTween(c.id)) {
        const t = transformFieldsOf(c.doc);
        if (t) smoothNodeTransform(c.id, t);
        return;
      }
      // A committed transform ends the gesture: the document shows it now.
      if (!hasNodeTween(c.id) && useEditorStore.getState().liveNodes[c.id])
        useEditorStore.getState().setLiveNode(c.id, null);
    });
  return () => {
    offLayers();
    offNodes();
  };
}
