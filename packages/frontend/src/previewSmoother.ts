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
 * Compose layers play back the same way (x/y/width/height linear, rotation in
 * degrees along the shortest arc).
 */

let rafHandle: number | null = null;

// --- playback buffers -----------------------------------------------------------

/** Field ops of one gesture sample arrive back to back (one per field). */
const SAME_SAMPLE_MS = 6;

interface Timed {
  /** When to show it, on this tab's clock (arrival, evened out). */
  t: number;
}

interface Track<S extends Timed> {
  samples: S[];
  /** Arrival of the newest sample, unadjusted. */
  lastArrival: number;
  /** Running estimate of the time between samples. */
  interval: number;
}

function newTrack<S extends Timed>(first: S): Track<S> {
  return { samples: [first], lastArrival: first.t, interval: 33 };
}

/** How far behind the newest samples a track is shown: enough to bridge an
 *  occasional late sample, not much more. */
function playbackDelay(track: Track<Timed>): number {
  return Math.min(160, Math.max(60, track.interval * 2.5));
}

/** The sample a field op arriving `now` writes into: the newest one if the op
 *  belongs to the same gesture sample, else a copy of it, timed and appended. */
function nextSample<S extends Timed>(
  track: Track<S>,
  now: number,
  copy: (s: S) => S
): S {
  const prev = track.samples[track.samples.length - 1];
  if (track.samples.length > 1 && now - track.lastArrival < SAME_SAMPLE_MS)
    return prev;
  const gap = now - track.lastArrival;
  if (track.samples.length > 1)
    track.interval =
      track.interval * 0.8 + Math.min(200, Math.max(8, gap)) * 0.2;
  const next = copy(prev);
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
  return next;
}

/** The two samples around `time` and how far between them it is. */
function bracket<S extends Timed>(
  track: Track<S>,
  time: number
): { a: S; b: S | undefined; k: number } {
  const s = track.samples;
  let i = 0;
  while (i < s.length - 1 && s[i + 1].t <= time) i++;
  const a = s[i];
  const b = s[i + 1];
  return { a, b, k: b && time > a.t ? (time - a.t) / (b.t - a.t) : 0 };
}

/** Forget samples played past (one at or before `time` stays, to interpolate
 *  from); true once the newest one has played. */
function trim(track: Track<Timed>, time: number): boolean {
  while (track.samples.length > 2 && track.samples[1].t <= time)
    track.samples.shift();
  return time >= track.samples[track.samples.length - 1].t;
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

// --- nodes -----------------------------------------------------------------------

const POS_FIELDS = ['x', 'y', 'z', 'sx', 'sy', 'sz'] as const;
const POS_DEFAULT: Record<string, number> = {
  x: 0,
  y: 0,
  z: 0,
  sx: 1,
  sy: 1,
  sz: 1,
};
interface NodeSample extends Timed {
  pos: Record<string, number>;
  q: THREE.Quaternion;
}

const nodeTracks = new Map<string, Track<NodeSample>>();

/** The node's transform at `time` on its track. */
function nodeAt(
  track: Track<NodeSample>,
  time: number
): Record<string, number> {
  const { a, b, k } = bracket(track, time);
  const out: Record<string, number> = {};
  const q = new THREE.Quaternion();
  if (!b) {
    Object.assign(out, a.pos);
    q.copy(a.q);
  } else {
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
    out.set(id, nodeAt(track, time));
    if (trim(track, time)) nodeTracks.delete(id);
  }
  return out;
}

// --- compose layers ----------------------------------------------------------------

const LAYER_FIELDS = ['x', 'y', 'width', 'height', 'rotation'] as const;

interface LayerSample extends Timed {
  v: Record<string, number>;
}

const layerTracks = new Map<string, Track<LayerSample>>();

/** Advance every layer track to `now`: what each shows, or null for a layer
 *  whose playback ended (its document holds the last preview). */
function playLayerTracks(
  now: number
): Map<string, Record<string, number> | null> {
  const out = new Map<string, Record<string, number> | null>();
  for (const [id, track] of layerTracks) {
    const time = now - playbackDelay(track);
    const { a, b, k } = bracket(track, time);
    const v: Record<string, number> = { ...a.v };
    if (b)
      for (const f of Object.keys(v))
        if (typeof b.v[f] === 'number') v[f] = lerp(a.v[f], b.v[f], k);
    if (trim(track, time)) {
      layerTracks.delete(id);
      out.set(id, null);
    } else out.set(id, v);
  }
  return out;
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
    if (layerTracks.size === 0 && nodeTracks.size === 0) return;

    const nodePatches = playNodeTracks(now);
    const layerPatches = playLayerTracks(now);

    const store = useEditorStore.getState();
    // A node's tween shows through `liveNodes`, and its last values stay there
    // until a committed transform replaces them (see startPreviewSmoothing):
    // node lists skip transform previews, so the document underneath still
    // holds the last committed position, not the preview's.
    for (const [nodeId, fields] of nodePatches)
      store.setLiveNode(nodeId, fields);
    // A layer's playback shows through `liveLayers` until it ends; then the
    // document — which already holds the last preview — shows on its own.
    for (const [layerId, fields] of layerPatches)
      store.setLiveLayer(layerId, fields as Partial<ComposeLayerRecord> | null);

    if (layerTracks.size > 0 || nodeTracks.size > 0)
      rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);
}

/** Whether this layer is playing back another tab's gesture.
 *
 *  The commit observer below uses this to decide how a COMMITTED value lands:
 *  mid gesture it joins the playback as its last sample, so the layer glides
 *  into its final position, but a value arriving cold (page load, a remote
 *  panel edit) applies immediately rather than animating in from wherever the
 *  live slice happened to be. */
export function hasLayerTween(id: string): boolean {
  return layerTracks.has(id);
}

/** Whether this node is playing back another tab's gesture (any field,
 *  rotation included). Same job as {@link hasLayerTween}: mid-gesture a
 *  committed value joins the playback as its last sample, so the node glides
 *  into its final pose instead of snapping. */
export function hasNodeTween(id: string): boolean {
  return nodeTracks.has(id);
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
    track = newTrack<NodeSample>({
      t: now,
      pos,
      q: new THREE.Quaternion().setFromEuler(eulerFromTransform(cur)),
    });
    nodeTracks.set(nodeId, track);
  }
  const next = nextSample(track, now, (p) => ({
    t: 0,
    pos: { ...p.pos },
    q: p.q.clone(),
  }));
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
  ensureLoop();
}

/** Feed an incoming compose-layer preview patch (any of x/y/width/height/
 *  rotation) into the layer's playback buffer. Other fields show as they
 *  arrive (the document already carries them). Rotation is 2D, in degrees: each
 *  sample is unwrapped to the shortest arc from the previous one, so
 *  interpolating it never spins the long way round. */
export function smoothComposeLayer(id: string, patch: Record<string, unknown>) {
  const fields = LAYER_FIELDS.filter((f) => typeof patch[f] === 'number');
  if (!fields.length) return;
  const now = performance.now();
  let track = layerTracks.get(id);
  if (!track) {
    const committed =
      collectionOf<Record<string, number>>('compose_layer').replica.raw(id);
    if (!committed) return;
    // Start from what this tab shows now: a live value, else the committed one
    // (the overlay already holds the target).
    const shown = useEditorStore.getState().liveLayers[id] as
      | Record<string, number>
      | undefined;
    const v: Record<string, number> = {};
    for (const f of LAYER_FIELDS) {
      const x = shown?.[f] ?? committed[f];
      if (typeof x === 'number') v[f] = x;
    }
    track = newTrack<LayerSample>({ t: now, v });
    layerTracks.set(id, track);
  }
  const next = nextSample(track, now, (p) => ({ t: 0, v: { ...p.v } }));
  for (const f of fields) {
    let to = patch[f] as number;
    const from = next.v[f];
    if (f === 'rotation' && typeof from === 'number') {
      let d = to - from;
      while (d > 180) d -= 360;
      while (d <= -180) d += 360;
      to = from + d;
    }
    next.v[f] = to;
  }
  ensureLoop();
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

/** Play back what another tab is dragging (the lossy `preview` channel), so it
 *  glides between samples. Mid-gesture, a committed value joins the playback
 *  as its last sample, so the node or layer glides into its final position
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
