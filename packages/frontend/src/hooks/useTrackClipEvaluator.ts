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

interface NodeAccumulator {
  position?: Record<'x' | 'y' | 'z', number | undefined>;
  rotation?: Record<'x' | 'y' | 'z', number | undefined>;
  scale?: Record<'x' | 'y' | 'z', number | undefined>;
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
        if (Object.keys(s.nodeTransformOverrides).length > 0) {
          for (const id of Object.keys(s.nodeTransformOverrides))
            s.setNodeTransformOverride(id, null);
        }
        if (Object.keys(s.composeLayerOverrides).length > 0) {
          for (const id of Object.keys(s.composeLayerOverrides))
            s.setComposeLayerOverride(id, null);
        }
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
        s.setNodeTransformOverride(nodeId, override);
      }
      for (const nodeId of prevNodeIds)
        s.setNodeTransformOverride(nodeId, null);

      const prevLayerIds = new Set(Object.keys(s.composeLayerOverrides));
      for (const [layerId, override] of layerAcc) {
        prevLayerIds.delete(layerId);
        s.setComposeLayerOverride(layerId, override);
      }
      for (const layerId of prevLayerIds)
        s.setComposeLayerOverride(layerId, null);

      for (const id of completed) s.setTrackClipPlayback(id, null);
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
    const field = lane.paramPath as 'x' | 'y' | 'rotation';
    if (field !== 'x' && field !== 'y' && field !== 'rotation') return;
    const base = layer[field];
    const absolute =
      mode === 'relative' ? base + (rawValue - lane.defaultValue) : rawValue;
    const acc = layerAcc.get(lane.targetId) ?? {};
    acc[field] = absolute;
    layerAcc.set(lane.targetId, acc);
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
