import type { AnimationBlendMode, TrackingMix } from '@vspark/shared';
import {
  blendshapeWeight,
  boneWeight,
  orderSources,
  scaleRotation,
} from '@vspark/shared/trackingMix';
import { Blendshapes, NormalizedPose, Quaternion } from '@vspark/shared/signal';
import type { VRMBoneName } from '@vspark/shared/signal';
import { getDb } from '../db/index.js';
import type { WSSync } from '../ws/index.js';
import { poseInterceptorRegistry } from '../signal/pose_interceptor_registry.js';
import { blendshapeInterceptorRegistry } from '../signal/blendshape_interceptor_registry.js';

const DEFAULT_TICK_HZ = 60;
const MIN_TICK_HZ = 1;
const MAX_TICK_HZ = 240;

export interface BoneSlot {
  /** The publishing behavior — the slot's Tracking Mix source key. */
  behaviorId: string;
  pose: NormalizedPose;
  priority: number;
  animationBlendMode: AnimationBlendMode;
}

export interface BlendshapeSlot {
  behaviorId: string;
  blendshapes: Blendshapes;
}

/** Reads an avatar node's Tracking Mix (`properties.trackingMix`). */
export type TrackingMixReader = (
  sceneNodeId: string
) => TrackingMix | undefined;

/** Per-(sceneNodeId, behaviorId) slot state held by the bus. */
interface ProducerSlots {
  /** Most recent bone publication, if any. */
  bones?: BoneSlot;
  /** Most recent blendshapes publication, if any. */
  blendshapes?: BlendshapeSlot;
}

/**
 * The Broadcast Bus is the single emission point for pose + blendshape WS messages.
 *
 * Producers (signal-graph broadcast nodes) call publishBones / publishBlendshapes
 * with their (sceneNodeId, behaviorId). On each scene's tick, the bus composes
 * all active slots for nodes in that scene, runs the pose interceptor chain on
 * the merged pose, and emits `vmc_pose` / `vmc_blendshapes` over the WebSocket.
 *
 * The bus decouples broadcast cadence from incoming event cadence, so subtle /
 * continuous workflows (breathing, idle blink) keep flowing even when no
 * tracking source is firing.
 */
export class BroadcastBus {
  private _ws: WSSync | null = null;
  /** Optional tap on every emitted pose/blendshape frame (keyed by sceneNodeId),
   *  used by multiplayer to forward shared avatars' live pose to subscribers.
   *  Injected at startup so the bus stays decoupled from the mesh. */
  private _forward:
    | ((kind: string, nodeId: string, payload: Record<string, unknown>) => void)
    | null = null;

  /** sceneId → setInterval handle */
  private readonly _timers = new Map<string, NodeJS.Timeout>();
  /** sceneId → current tick rate */
  private readonly _tickRates = new Map<string, number>();
  /** sceneId → sceneNodeId → behaviorId → slots */
  private readonly _slots = new Map<
    string,
    Map<string, Map<string, ProducerSlots>>
  >();
  /** sceneNodeId → sceneId (lookup cache; populated on first publish) */
  private readonly _nodeScene = new Map<string, string>();

  /** Where the per-avatar Tracking Mix comes from. Injected at startup (the
   *  mesh's scene_node collection, whose reads include live preview overlays,
   *  so a slider drag reweights tracking before it is committed). Without one,
   *  every weight is 1 — the pre-mix stacking. */
  private _mixReader: TrackingMixReader | null = null;

  init(ws: WSSync): void {
    this._ws = ws;
  }

  /** Install the Tracking Mix source (idempotent). */
  setTrackingMixReader(fn: TrackingMixReader | null): void {
    this._mixReader = fn;
  }

  private _mixOf(sceneNodeId: string): TrackingMix | undefined {
    if (!this._mixReader) return undefined;
    try {
      return this._mixReader(sceneNodeId);
    } catch {
      return undefined; // a bad read must not stop the tick
    }
  }

  /** Install the multiplayer stream forwarder (idempotent). */
  setStreamForwarder(
    fn: (kind: string, nodeId: string, payload: Record<string, unknown>) => void
  ): void {
    this._forward = fn;
  }

  /** Broadcast a frame locally and tap the forwarder for shared-avatar fan-out. */
  private _bcast(
    kind: string,
    nodeId: string,
    payload: Record<string, unknown>
  ): void {
    this._ws?.broadcast(kind, payload);
    this._forward?.(kind, nodeId, payload);
  }

  /** Publish bone pose for (sceneNodeId, behaviorId). Slot is fully replaced. */
  publishBones(
    sceneNodeId: string,
    behaviorId: string,
    pose: NormalizedPose,
    priority: number,
    animationBlendMode: AnimationBlendMode
  ): void {
    if (!_isIterableMap(pose))
      return this._rejectPublish('bones', behaviorId, pose);
    const slot = this._slot(sceneNodeId, behaviorId);
    if (!slot) return;
    slot.bones = { behaviorId, pose, priority, animationBlendMode };
  }

  /** Publish blendshapes for (sceneNodeId, behaviorId). Slot is fully replaced. */
  publishBlendshapes(
    sceneNodeId: string,
    behaviorId: string,
    blendshapes: Blendshapes
  ): void {
    if (!_isIterableMap(blendshapes))
      return this._rejectPublish('blendshapes', behaviorId, blendshapes);
    const slot = this._slot(sceneNodeId, behaviorId);
    if (!slot) return;
    slot.blendshapes = { behaviorId, blendshapes };
  }

  /** Behaviors already warned about, so a 60 Hz producer logs once, not per frame. */
  private readonly _warned = new Set<string>();

  /**
   * Drop a malformed publication instead of parking it in a slot. Composition runs
   * on a timer, so a bad value stored here would throw on every tick — outside any
   * request scope — and take the process down with it.
   */
  private _rejectPublish(
    what: string,
    behaviorId: string,
    value: unknown
  ): void {
    const key = `${what}:${behaviorId}`;
    if (this._warned.has(key)) return;
    this._warned.add(key);
    console.warn(
      `[BroadcastBus] Ignoring ${what} from behavior ${behaviorId}: ` +
        `expected a ${what === 'bones' ? 'NormalizedPose' : 'Blendshapes'}, got ${_describe(value)}`
    );
  }

  /** Drop all slots belonging to a component (call when the component is deleted/recreated,
   *  or when a producer like vmc_receiver loses tracking and should fall out of the merge).
   *
   *  When removing a slot makes its parent nodeMap empty, the bus emits one final fallback
   *  frame on that sceneNode — empty bones with `animationBlendMode: 'additive'` and empty
   *  blendshapes — so the frontend ramps back to pure animation rather than holding the
   *  last live frame. The empty nodeMap entry is then dropped. */
  removeBehavior(behaviorId: string): void {
    for (const sceneMap of this._slots.values()) {
      for (const [sceneNodeId, nodeMap] of sceneMap) {
        if (!nodeMap.has(behaviorId)) continue;
        nodeMap.delete(behaviorId);
        if (nodeMap.size === 0) {
          this._emitFallback(sceneNodeId);
          sceneMap.delete(sceneNodeId);
          this._pendingModes.delete(sceneNodeId);
        }
        this._warned.delete(`bones:${behaviorId}`);
        this._warned.delete(`blendshapes:${behaviorId}`);
      }
    }
  }

  private _emitFallback(sceneNodeId: string): void {
    this._bcast('vmc_pose', sceneNodeId, {
      nodeId: sceneNodeId,
      bones: {},
      animationBlendMode: 'additive' as AnimationBlendMode,
    });
    this._bcast('vmc_blendshapes', sceneNodeId, {
      nodeId: sceneNodeId,
      blendshapes: {},
    });
  }

  /**
   * Set the tick rate for a scene. Restarts the scene's ticker.
   * Pass `undefined` to use the default rate.
   */
  setSceneTickRate(sceneId: string, hz: number | undefined): void {
    const clamped = _clampHz(hz ?? DEFAULT_TICK_HZ);
    const current = this._tickRates.get(sceneId);
    if (current === clamped && this._timers.has(sceneId)) return;
    this._stopScene(sceneId);
    this._tickRates.set(sceneId, clamped);
    this._startScene(sceneId, clamped);
  }

  /** Stop all per-scene timers (used at shutdown). */
  stop(): void {
    for (const sceneId of Array.from(this._timers.keys()))
      this._stopScene(sceneId);
  }

  private _slot(sceneNodeId: string, behaviorId: string): ProducerSlots | null {
    const sceneId = this._resolveSceneId(sceneNodeId);
    if (!sceneId) return null;
    let sceneMap = this._slots.get(sceneId);
    if (!sceneMap) {
      sceneMap = new Map();
      this._slots.set(sceneId, sceneMap);
    }
    let nodeMap = sceneMap.get(sceneNodeId);
    if (!nodeMap) {
      nodeMap = new Map();
      sceneMap.set(sceneNodeId, nodeMap);
    }
    let slot = nodeMap.get(behaviorId);
    if (!slot) {
      slot = {};
      nodeMap.set(behaviorId, slot);
    }
    // Lazily start the scene ticker the first time it sees activity.
    if (!this._timers.has(sceneId)) {
      const hz = this._tickRates.get(sceneId) ?? this._loadSceneTickHz(sceneId);
      this._tickRates.set(sceneId, hz);
      this._startScene(sceneId, hz);
    }
    return slot;
  }

  private _resolveSceneId(sceneNodeId: string): string | null {
    const cached = this._nodeScene.get(sceneNodeId);
    if (cached) return cached;
    const row = getDb()
      .prepare('SELECT root_scene_node_id FROM scene_nodes WHERE id = ?')
      .get(sceneNodeId) as { root_scene_node_id: string } | undefined;
    if (!row?.root_scene_node_id) return null;
    this._nodeScene.set(sceneNodeId, row.root_scene_node_id);
    return row.root_scene_node_id;
  }

  private _loadSceneTickHz(sceneId: string): number {
    const row = getDb()
      .prepare(
        "SELECT properties FROM scene_nodes WHERE id = ? AND kind = 'scene'"
      )
      .get(sceneId) as { properties: string } | undefined;
    if (!row?.properties) return DEFAULT_TICK_HZ;
    try {
      const parsed = JSON.parse(row.properties) as { broadcastTickHz?: number };
      return _clampHz(parsed.broadcastTickHz ?? DEFAULT_TICK_HZ);
    } catch {
      return DEFAULT_TICK_HZ;
    }
  }

  private _startScene(sceneId: string, hz: number): void {
    const intervalMs = 1000 / hz;
    const handle = setInterval(() => this._tick(sceneId), intervalMs);
    this._timers.set(sceneId, handle);
  }

  private _stopScene(sceneId: string): void {
    const h = this._timers.get(sceneId);
    if (h) clearInterval(h);
    this._timers.delete(sceneId);
  }

  private _tick(sceneId: string): void {
    const sceneMap = this._slots.get(sceneId);
    if (!sceneMap || sceneMap.size === 0) return;
    for (const [sceneNodeId, nodeMap] of sceneMap) {
      if (nodeMap.size === 0) continue;
      try {
        this._composeAndEmit(sceneNodeId, nodeMap);
      } catch (err) {
        // The tick has no caller to propagate to — an escaping throw would be an
        // unhandled exception and stop the server. Skip this node, keep ticking.
        console.error(`[BroadcastBus] compose failed for ${sceneNodeId}:`, err);
      }
    }
  }

  private _composeAndEmit(
    sceneNodeId: string,
    nodeMap: Map<string, ProducerSlots>
  ): void {
    // Compose bones.
    const boneSlots: BoneSlot[] = [];
    const bsSlots: BlendshapeSlot[] = [];
    for (const slots of nodeMap.values()) {
      if (slots.bones) boneSlots.push(slots.bones);
      if (slots.blendshapes) bsSlots.push(slots.blendshapes);
    }

    const mix =
      boneSlots.length > 0 || bsSlots.length > 0
        ? this._mixOf(sceneNodeId)
        : undefined;

    if (boneSlots.length > 0) {
      const composed = _composeBones(boneSlots, mix);
      const mode = _resolveAnimationBlendMode(boneSlots);
      if (!poseInterceptorRegistry.start(sceneNodeId, composed)) {
        this._emitPose(sceneNodeId, composed, mode);
      }
      // If interceptors handle it, they call broadcastMergedPose to finalize.
      // We store the resolved mode for the interceptor terminal to read.
      this._pendingModes.set(sceneNodeId, mode);
    }

    if (bsSlots.length > 0) {
      const merged = _composeBlendshapes(bsSlots, mix);
      // Same hand-off as the pose path: if any blendshape interceptor is
      // registered for this node (e.g. the Expression Limits behavior), the
      // chain terminal emits via emitMergedBlendshapes instead.
      if (!blendshapeInterceptorRegistry.start(sceneNodeId, merged)) {
        this._emitBlendshapes(sceneNodeId, merged);
      }
    }
  }

  /** Cached blend-mode-per-scene-node so interceptor terminals can include it on emit. */
  private readonly _pendingModes = new Map<string, AnimationBlendMode>();

  /** Called by interceptor terminal (pose_interceptor_broadcast) after the chain runs. */
  emitMergedPose(sceneNodeId: string, pose: NormalizedPose): void {
    const mode = this._pendingModes.get(sceneNodeId) ?? 'override';
    this._emitPose(sceneNodeId, pose, mode);
  }

  /** Called by the blendshape interceptor terminal after the chain runs. */
  emitMergedBlendshapes(sceneNodeId: string, blendshapes: Blendshapes): void {
    this._emitBlendshapes(sceneNodeId, blendshapes);
  }

  private _emitBlendshapes(
    sceneNodeId: string,
    blendshapes: Blendshapes
  ): void {
    this._bcast('vmc_blendshapes', sceneNodeId, {
      nodeId: sceneNodeId,
      blendshapes: blendshapes.toRecord(),
    });
  }

  private _emitPose(
    sceneNodeId: string,
    pose: NormalizedPose,
    mode: AnimationBlendMode
  ): void {
    this._bcast('vmc_pose', sceneNodeId, {
      nodeId: sceneNodeId,
      bones: pose.toRecord(),
      animationBlendMode: mode,
      // Omitted for rotation-only poses, which is nearly all of them.
      ...(pose.offsetCount > 0 ? { offsets: pose.offsetsToRecord() } : {}),
    });
  }

  /** Notify the bus that a scene's runtime settings changed (e.g. via PUT /scenes/:id). */
  reloadSceneSettings(sceneId: string): void {
    const hz = this._loadSceneTickHz(sceneId);
    this.setSceneTickRate(sceneId, hz);
  }
}

/**
 * Structural check for the map-like value classes the bus composes
 * (`NormalizedPose` / `Blendshapes`): it only ever calls `entries()` and
 * `toRecord()` on them. Structural rather than `instanceof` so a value that
 * crossed a module boundary (bundled build, duplicated package copy) still
 * passes, while a JSON-revived plain object — which has neither method — does not.
 */
function _isIterableMap(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as { entries?: unknown; toRecord?: unknown };
  return typeof o.entries === 'function' && typeof o.toRecord === 'function';
}

/** Short, log-safe description of a rejected publication. */
function _describe(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v !== 'object') return typeof v;
  return `${(v as object).constructor?.name ?? 'object'} ${JSON.stringify(v)?.slice(0, 120) ?? ''}`;
}

function _clampHz(hz: number): number {
  if (!Number.isFinite(hz)) return DEFAULT_TICK_HZ;
  return Math.max(MIN_TICK_HZ, Math.min(MAX_TICK_HZ, hz));
}

/**
 * Compose bone slots under the avatar's Tracking Mix: slots are ordered by
 * `mix.order` (unlisted ones by ascending priority), and each slot's bone is
 * scaled toward identity by its weight (`scaleRotation`) before being
 * multiplied onto the accumulator. Weights are not normalised — with no mix
 * every weight is 1 and this is plain priority-ordered stacking.
 *
 * Bones absent from all slots — or present only with weight 0 — are omitted
 * from the output, so the frontend leaves them to the animation.
 */
export function _composeBones(
  slots: BoneSlot[],
  mix?: TrackingMix
): NormalizedPose {
  const sorted = orderSources(
    mix,
    slots.map((s) => ({ ...s, id: s.behaviorId }))
  );
  const acc = new Map<VRMBoneName, Quaternion>();
  // Translations SUM across slots rather than composing like the rotations do —
  // two producers each nudging the hips should displace them by the total.
  const offsets = new Map<VRMBoneName, [number, number, number]>();
  for (const slot of sorted) {
    for (const [bone, q] of slot.pose.entries()) {
      const w = boneWeight(mix, slot.behaviorId, bone);
      if (w === 0) continue;
      const scaled = scaleRotation(q, w);
      const existing = acc.get(bone);
      acc.set(bone, existing ? scaled.multiply(existing) : scaled);
    }
    for (const [bone, v] of slot.pose.offsetEntries()) {
      const w = boneWeight(mix, slot.behaviorId, bone);
      if (w === 0) continue;
      const prev = offsets.get(bone);
      offsets.set(
        bone,
        prev
          ? [prev[0] + v[0] * w, prev[1] + v[1] * w, prev[2] + v[2] * w]
          : [v[0] * w, v[1] * w, v[2] * w]
      );
    }
  }
  return new NormalizedPose(acc.entries(), offsets.entries());
}

/** Compose blendshapes additively across slots (`weight × value`, weights from
 *  the Tracking Mix, default 1), clamped to [0, 1]. Order doesn't matter. */
export function _composeBlendshapes(
  slots: BlendshapeSlot[],
  mix?: TrackingMix
): Blendshapes {
  const sums = new Map<string, number>();
  for (const slot of slots) {
    for (const [name, value] of slot.blendshapes.entries()) {
      const w = blendshapeWeight(mix, slot.behaviorId, name);
      if (w === 0 && !sums.has(name)) continue;
      sums.set(name, (sums.get(name) ?? 0) + value * w);
    }
  }
  for (const [name, total] of sums)
    sums.set(name, Math.max(0, Math.min(1, total)));
  return new Blendshapes(sums.entries());
}

/** If any slot is `override`, the resolved per-node mode is `override`; else `additive`. */
function _resolveAnimationBlendMode(slots: BoneSlot[]): AnimationBlendMode {
  for (const s of slots)
    if (s.animationBlendMode === 'override') return 'override';
  return 'additive';
}

export const broadcastBus = new BroadcastBus();
