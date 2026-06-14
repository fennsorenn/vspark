import { useEffect } from 'react';
import { useEditorStore } from '../store/editorStore';
import type {
  ComposeLayerOverride,
  NodeTransformOverride,
} from '../store/editorStore';
import type {
  TrackClipLaneRecord,
  TrackClipMode,
  TrackClipRecord,
} from '../api/client';
import {
  evaluateLane,
  resolveClipTime,
} from '../components/editor/trackClipEvaluator';
import { dispatchMediaCommand } from '../components/editor/mediaRegistry';
import { useConnectionsStore } from '../store/connectionsStore';
import { sendSharedNodeTransform } from './useWsSync';
import type { MediaCommand, MediaAction } from '@vspark/shared';

// Per-clip last evaluated playhead time, kept across rAF ticks (module scope so
// it survives re-renders). Used to detect when the playhead crosses an event
// marker so each marker fires exactly once per pass (re-armed per loop).
const lastTByClip = new Map<string, number>();

/** Did the playhead cross marker time `m` going from `prev` to `cur`? Handles
 *  the loop wrap (cur < prev) by treating the pass as (prev, duration] ∪ [0, cur]. */
function crossedMarker(
  prev: number,
  cur: number,
  m: number,
  duration: number,
  loop: boolean
): boolean {
  if (!loop || cur >= prev) return prev < m && m <= cur;
  // Wrapped this frame.
  return (m > prev && m <= duration) || (m >= 0 && m <= cur);
}

interface NodeAccumulator {
  position?: Record<'x' | 'y' | 'z', number | undefined>;
  rotation?: Record<'x' | 'y' | 'z', number | undefined>;
  scale?: Record<'x' | 'y' | 'z', number | undefined>;
  opacity?: number;
}

// --- shared-object clip animation forwarding --------------------------------
//
// A track clip animating a *shared* object's transform must reach subscribers,
// but clip evaluation is frontend-local (no graph output, no persisted edit), so
// it rides the existing `node_transform_preview` stream: emit the live transform
// each frame for animated nodes, and emit the *base* transform once when a node
// stops animating so the receiver smooths back (the preview path has no auto-
// clear). The backend's forwardStream filters to actually-subscribed roots, so
// emitting for any animated node when a peer is connected is safe; we just gate
// on connectivity to avoid per-frame WS chatter when no one's listening.
//
// Boundary: forwardStream keys on the shared-object *root* id, so a clip
// animating a child *inside* a shared subtree isn't forwarded (same as a drag of
// a shared child). Opacity isn't carried by the transform preview either.
const forwardedClipNodes = new Set<string>();
/** Nodes that just stopped animating → re-emit base for a few frames so the
 *  revert isn't lost on the lossy stream channel (server-relay subscribers;
 *  the browser-direct edge is reliable). id → frames left. */
const revertingClipNodes = new Map<string, number>();
const REVERT_REPEATS = 4;
const EMPTY_ACC = new Map<string, NodeAccumulator>();
let lastClipEmitAt = 0;
const CLIP_EMIT_MS = 33; // ~30 Hz, matching the drag-preview cadence

/** The node's persisted transform as a flat `{x,y,z,rx,…,sz}` payload, with any
 *  animated axes from `acc` (absolute values) overlaid. */
function buildFlatTransform(
  node: { components: Record<string, unknown> },
  acc?: NodeAccumulator
): Record<string, number> {
  const t = (node.components?.transform ?? {}) as FlatTransform;
  const flat: Record<string, number> = {
    x: t.x ?? 0,
    y: t.y ?? 0,
    z: t.z ?? 0,
    rx: t.rx ?? 0,
    ry: t.ry ?? 0,
    rz: t.rz ?? 0,
    sx: t.sx ?? 1,
    sy: t.sy ?? 1,
    sz: t.sz ?? 1,
  };
  const overlay = (
    group: Record<'x' | 'y' | 'z', number | undefined> | undefined,
    prefix: string
  ): void => {
    if (!group) return;
    for (const a of ['x', 'y', 'z'] as const)
      if (group[a] !== undefined) flat[prefix + a] = group[a]!;
  };
  overlay(acc?.position, '');
  overlay(acc?.rotation, 'r');
  overlay(acc?.scale, 's');
  return flat;
}

function syncSharedClipTransforms(
  s: ReturnType<typeof useEditorStore.getState>,
  nodeAcc: Map<string, NodeAccumulator>,
  cleared: Iterable<string>
): void {
  // Only when a contact is connected (a potential subscriber). The backend
  // narrows to actually-shared roots; this just avoids idle WS traffic.
  if (useConnectionsStore.getState().connectedIds.length === 0) {
    forwardedClipNodes.clear();
    revertingClipNodes.clear();
    return;
  }
  // Nodes that stopped animating this frame → schedule a base-transform revert.
  for (const id of cleared)
    if (forwardedClipNodes.delete(id)) revertingClipNodes.set(id, REVERT_REPEATS);
  // Emit pending reverts every frame (unthrottled) until exhausted, so a dropped
  // frame on the lossy channel doesn't leave the receiver stuck at the last pose.
  for (const [id, left] of revertingClipNodes) {
    const node = s.nodes.find((n) => n.id === id);
    if (node) sendSharedNodeTransform(id, buildFlatTransform(node));
    if (left <= 1) revertingClipNodes.delete(id);
    else revertingClipNodes.set(id, left - 1);
  }
  // Active animations (throttled).
  const now =
    typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - lastClipEmitAt < CLIP_EMIT_MS) return;
  lastClipEmitAt = now;
  for (const [id, acc] of nodeAcc) {
    const node = s.nodes.find((n) => n.id === id);
    if (!node) continue;
    revertingClipNodes.delete(id); // re-animated → cancel any pending revert
    sendSharedNodeTransform(id, buildFlatTransform(node, acc));
    forwardedClipNodes.add(id);
  }
}

/** Per-frame evaluator. Reads `trackClipPlayback` + `trackClips`, computes scalar
 *  values for every active lane, and pushes results into:
 *    - `nodeTransformOverrides` (read by Viewport in its useFrame and applied via direct Three.js mutation)
 *    - `composeLayerOverrides`  (read by ComposeLayerStack / ComposeView when rendering layers)
 *  Mode application:
 *    - 'override': override value = evaluated lane value
 *    - 'relative': override value = base + (evaluated − lane.defaultValue), where
 *      base is the persisted transform/layer field. The viewport / layer renderer adds
 *      these on top of the persisted base, so we emit the *delta* component for relative.
 *      To keep the override consistent regardless of mode, we emit the absolute target
 *      value and let consumers ignore the persisted base. The consumer therefore must
 *      know to ADD vs REPLACE; we encode that by writing a `_mode` field. Simpler: emit
 *      the absolute target the renderer should apply for each scalar.
 *
 *  For 'relative', we still need the persisted base. We read it from the store at
 *  evaluation time (nodes for scene_node, composeLayers for compose_layer) and compose
 *  the absolute value here, so the consumer can treat both modes the same: "if an
 *  override is present for this scalar, replace the persisted value with the override."
 */
export function useTrackClipEvaluator(): void {
  useEffect(() => {
    let raf = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const s = useEditorStore.getState();
      const playback = s.trackClipPlayback;
      const playbackEntries = Object.entries(playback);
      // Fast exit + cleanup when nothing is playing.
      if (playbackEntries.length === 0) {
        if (lastTByClip.size > 0) lastTByClip.clear();
        if (Object.keys(s.nodeTransformOverrides).length > 0) {
          for (const id of Object.keys(s.nodeTransformOverrides))
            s.setNodeTransformOverride(id, null);
        }
        if (Object.keys(s.composeLayerOverrides).length > 0) {
          for (const id of Object.keys(s.composeLayerOverrides))
            s.setComposeLayerOverride(id, null);
        }
        // Revert any shared objects we were animating back to their base on
        // subscribers (nothing playing → all forwarded nodes are cleared).
        syncSharedClipTransforms(s, EMPTY_ACC, [...forwardedClipNodes]);
        return;
      }

      const clipById = new Map<string, TrackClipRecord>(
        s.trackClips.map((c) => [c.id, c])
      );
      const nodeAcc = new Map<string, NodeAccumulator>();
      const layerAcc = new Map<string, ComposeLayerOverride>();
      const completed: string[] = [];

      for (const [clipId, entry] of playbackEntries) {
        const clip = clipById.get(clipId);
        if (!clip) continue;
        let t: number | null;
        if (entry.kind === 'paused') {
          // Frozen — don't advance, don't complete. Still re-eval each frame so
          // any lane/keyframe edits while paused take effect immediately.
          t = resolveClipTime(entry.pausedAtT, clip.duration, entry.loop);
        } else {
          const tRaw =
            (Date.now() + entry.clockOffsetMs - entry.startedAt) / 1000;
          t = resolveClipTime(tRaw, clip.duration, entry.loop);
        }
        if (t == null) {
          completed.push(clipId);
          continue;
        }
        // Fire event-lane markers crossed since the last tick (playing only;
        // paused clips don't advance so nothing is crossed).
        if (entry.kind === 'playing' && clip.events.length > 0) {
          const prevT = lastTByClip.has(clipId)
            ? lastTByClip.get(clipId)!
            : -Infinity;
          if (t !== prevT) {
            for (const ev of clip.events) {
              if (crossedMarker(prevT, t, ev.t, clip.duration, entry.loop)) {
                const cmd: MediaCommand = { action: ev.action as MediaAction };
                const p = ev.payload as Record<string, unknown> | null;
                if (p && typeof p.t === 'number') cmd.t = p.t;
                if (p && typeof p.volume === 'number') cmd.volume = p.volume;
                dispatchMediaCommand(ev.targetId, cmd);
              }
            }
          }
        }
        lastTByClip.set(clipId, t);
        for (const lane of clip.lanes) {
          // User edits on a driven param insert a key here; skip those so the
          // base value stays visible until the next clip event clears the set.
          const supKey = `${lane.targetKind}:${lane.targetId}:${lane.paramPath}`;
          if (s.suppressedOverrides.has(supKey)) continue;
          const raw = evaluateLane(lane, t);
          applyLaneResult(lane, raw, clip.mode, s, nodeAcc, layerAcc);
        }
      }

      // Push results into the store. We only set when changed to avoid extra renders.
      // Always clear stale overrides on the next frame.
      const prevNodeIds = new Set(Object.keys(s.nodeTransformOverrides));
      for (const [nodeId, acc] of nodeAcc) {
        prevNodeIds.delete(nodeId);
        const override: NodeTransformOverride = {};
        if (acc.position) override.position = pruneAxes(acc.position);
        if (acc.rotation) override.rotation = pruneAxes(acc.rotation);
        if (acc.scale) override.scale = pruneAxes(acc.scale);
        if (acc.opacity !== undefined) override.opacity = acc.opacity;
        s.setNodeTransformOverride(nodeId, override);
      }
      for (const nodeId of prevNodeIds)
        s.setNodeTransformOverride(nodeId, null);

      // Forward clip-driven transforms of shared objects to subscribers, and
      // revert nodes that stopped animating this frame (prevNodeIds) to base.
      syncSharedClipTransforms(s, nodeAcc, prevNodeIds);

      const prevLayerIds = new Set(Object.keys(s.composeLayerOverrides));
      for (const [layerId, override] of layerAcc) {
        prevLayerIds.delete(layerId);
        s.setComposeLayerOverride(layerId, override);
      }
      for (const layerId of prevLayerIds)
        s.setComposeLayerOverride(layerId, null);

      for (const id of completed) {
        s.setTrackClipPlayback(id, null);
        lastTByClip.delete(id);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
}

function applyLaneResult(
  lane: TrackClipLaneRecord,
  rawValue: number,
  mode: TrackClipMode,
  store: ReturnType<typeof useEditorStore.getState>,
  nodeAcc: Map<string, NodeAccumulator>,
  layerAcc: Map<string, ComposeLayerOverride>
): void {
  if (lane.targetKind === 'scene_node') {
    const node = store.nodes.find((n) => n.id === lane.targetId);
    if (!node) return;
    const base = readNodeParam(node, lane.paramPath);
    if (base == null) return;
    const absolute =
      mode === 'relative' ? base + (rawValue - lane.defaultValue) : rawValue;
    let acc = nodeAcc.get(lane.targetId);
    if (!acc) {
      acc = {};
      nodeAcc.set(lane.targetId, acc);
    }
    writeNodeParam(acc, lane.paramPath, absolute);
    return;
  }
  if (lane.targetKind === 'compose_layer') {
    const layer = store.composeLayers.find((l) => l.id === lane.targetId);
    if (!layer) return;
    const base = readComposeParam(layer, lane.paramPath);
    if (base == null) return;
    const absolute =
      mode === 'relative' ? base + (rawValue - lane.defaultValue) : rawValue;
    const acc = layerAcc.get(lane.targetId) ?? {};
    writeComposeParam(acc, lane.paramPath, absolute);
    layerAcc.set(lane.targetId, acc);
  }
}

/** Read the persisted base for a compose-layer paramPath. Mirrors the
 *  paramPath registry in shared (kept in sync with packages/shared/src/paramPaths.ts). */
function readComposeParam(
  layer: { x: number; y: number; rotation: number; width: number; height: number; config: Record<string, unknown> },
  paramPath: string
): number | null {
  switch (paramPath) {
    case 'x':
      return layer.x;
    case 'y':
      return layer.y;
    case 'rotation':
      return layer.rotation;
    case 'width':
      return layer.width;
    case 'height':
      return layer.height;
    case 'opacity':
      return typeof layer.config.opacity === 'number' ? layer.config.opacity : 1;
    default:
      return null;
  }
}

function writeComposeParam(
  acc: ComposeLayerOverride,
  paramPath: string,
  value: number
): void {
  switch (paramPath) {
    case 'x':
      acc.x = value;
      return;
    case 'y':
      acc.y = value;
      return;
    case 'rotation':
      acc.rotation = value;
      return;
    case 'width':
      acc.width = value;
      return;
    case 'height':
      acc.height = value;
      return;
    case 'opacity':
      acc.opacity = value;
      return;
  }
}

type V3 = { x?: number; y?: number; z?: number };

/** The node transform component is stored flat as { x, y, z, rx, ry, rz, sx, sy, sz },
 *  not as nested arrays. param_path uses the conceptual "position.x" form; this
 *  helper bridges the two. */
type FlatTransform = {
  x?: number;
  y?: number;
  z?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  sx?: number;
  sy?: number;
  sz?: number;
  opacity?: number;
};

function flatKeyFor(paramPath: string): keyof FlatTransform | null {
  const [group, axis] = paramPath.split('.');
  if (axis !== 'x' && axis !== 'y' && axis !== 'z') return null;
  if (group === 'position') return axis as 'x' | 'y' | 'z';
  if (group === 'rotation') return ('r' + axis) as 'rx' | 'ry' | 'rz';
  if (group === 'scale') return ('s' + axis) as 'sx' | 'sy' | 'sz';
  return null;
}

function readNodeParam(
  node: { components: Record<string, unknown> },
  paramPath: string
): number | null {
  const t = node.components?.transform as FlatTransform | undefined;
  if (paramPath === 'opacity') return t?.opacity ?? 1;
  const key = flatKeyFor(paramPath);
  if (!key) return null;
  const v = t?.[key];
  if (v !== undefined) return v;
  // Defaults: scale = 1, others = 0.
  return paramPath.startsWith('scale.') ? 1 : 0;
}

function writeNodeParam(
  acc: NodeAccumulator,
  paramPath: string,
  value: number
): void {
  if (paramPath === 'opacity') {
    acc.opacity = value;
    return;
  }
  const [group, axis] = paramPath.split('.');
  if (axis !== 'x' && axis !== 'y' && axis !== 'z') return;
  if (group === 'position') {
    acc.position ??= { x: undefined, y: undefined, z: undefined };
    (acc.position as V3)[axis] = value;
    return;
  }
  if (group === 'rotation') {
    acc.rotation ??= { x: undefined, y: undefined, z: undefined };
    (acc.rotation as V3)[axis] = value;
    return;
  }
  if (group === 'scale') {
    acc.scale ??= { x: undefined, y: undefined, z: undefined };
    (acc.scale as V3)[axis] = value;
    return;
  }
}

function pruneAxes(v: Record<'x' | 'y' | 'z', number | undefined>): {
  x?: number;
  y?: number;
  z?: number;
} {
  const out: { x?: number; y?: number; z?: number } = {};
  if (v.x !== undefined) out.x = v.x;
  if (v.y !== undefined) out.y = v.y;
  if (v.z !== undefined) out.z = v.z;
  return out;
}
