/**
 * Signal graph type system.
 *
 * Data types, the Event<T> push-signal wrapper, typed port machinery,
 * the @SignalNode class decorator, and graph descriptor types.
 */

// ──────────────────────────────────────────────────────────────────────────────
// VRM bone name registry (VRM 1.x humanoid spec)
// ──────────────────────────────────────────────────────────────────────────────

export const VRM_BONE_NAMES = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'jaw',
  'leftEye',
  'rightEye',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'leftToes',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
  'rightToes',
  'leftThumbMetacarpal',
  'leftThumbProximal',
  'leftThumbDistal',
  'leftIndexProximal',
  'leftIndexIntermediate',
  'leftIndexDistal',
  'leftMiddleProximal',
  'leftMiddleIntermediate',
  'leftMiddleDistal',
  'leftRingProximal',
  'leftRingIntermediate',
  'leftRingDistal',
  'leftLittleProximal',
  'leftLittleIntermediate',
  'leftLittleDistal',
  'rightThumbMetacarpal',
  'rightThumbProximal',
  'rightThumbDistal',
  'rightIndexProximal',
  'rightIndexIntermediate',
  'rightIndexDistal',
  'rightMiddleProximal',
  'rightMiddleIntermediate',
  'rightMiddleDistal',
  'rightRingProximal',
  'rightRingIntermediate',
  'rightRingDistal',
  'rightLittleProximal',
  'rightLittleIntermediate',
  'rightLittleDistal',
] as const;

export type VRMBoneName = (typeof VRM_BONE_NAMES)[number];

// ──────────────────────────────────────────────────────────────────────────────
// Quaternion — immutable unit quaternion with full algebra
// ──────────────────────────────────────────────────────────────────────────────

export class Quaternion {
  constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly z: number,
    public readonly w: number
  ) {}

  static readonly IDENTITY = new Quaternion(0, 0, 0, 1);

  static fromArray(a: readonly [number, number, number, number]): Quaternion {
    return new Quaternion(a[0], a[1], a[2], a[3]);
  }

  toArray(): [number, number, number, number] {
    return [this.x, this.y, this.z, this.w];
  }

  get magnitudeSquared(): number {
    return (
      this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w
    );
  }

  get isValid(): boolean {
    return this.magnitudeSquared > 1e-9;
  }

  normalize(): Quaternion {
    const len = Math.sqrt(this.magnitudeSquared);
    if (len < 1e-9) return Quaternion.IDENTITY;
    return new Quaternion(
      this.x / len,
      this.y / len,
      this.z / len,
      this.w / len
    );
  }

  invert(): Quaternion {
    const m2 = this.magnitudeSquared;
    if (m2 < 1e-9) return Quaternion.IDENTITY;
    const s = 1 / m2;
    return new Quaternion(-this.x * s, -this.y * s, -this.z * s, this.w * s);
  }

  multiply(rhs: Quaternion): Quaternion {
    const { x: ax, y: ay, z: az, w: aw } = this;
    const { x: bx, y: by, z: bz, w: bw } = rhs;
    return new Quaternion(
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz
    );
  }

  premultiply(lhs: Quaternion): Quaternion {
    return lhs.multiply(this);
  }

  /**
   * Build a unit quaternion from intrinsic ZYX Euler angles (radians):
   * Rz(roll) · Ry(yaw) · Rx(pitch). pitch = X axis, yaw = Y axis, roll = Z axis.
   * Matches the `euler_to_quaternion` signal node convention; `toEuler` is its inverse.
   */
  static fromEuler(pitch: number, yaw: number, roll: number): Quaternion {
    const cx = Math.cos(pitch / 2),
      sx = Math.sin(pitch / 2);
    const cy = Math.cos(yaw / 2),
      sy = Math.sin(yaw / 2);
    const cz = Math.cos(roll / 2),
      sz = Math.sin(roll / 2);
    return new Quaternion(
      sx * cy * cz - cx * sy * sz,
      cx * sy * cz + sx * cy * sz,
      cx * cy * sz - sx * sy * cz,
      cx * cy * cz + sx * sy * sz
    ).normalize();
  }

  /**
   * Decompose into intrinsic ZYX Euler angles (radians), the inverse of `fromEuler`.
   * Returns `{ pitch, yaw, roll }` (X, Y, Z). Near the yaw = ±90° singularity
   * (gimbal lock) the roll/pitch split is ambiguous; this collapses the coupled
   * rotation onto `roll` and returns `pitch = 0` — acceptable for manual calibration.
   */
  toEuler(): { pitch: number; yaw: number; roll: number } {
    const { x, y, z, w } = this.normalize();
    const sinYaw = 2 * (w * y - x * z);
    if (Math.abs(sinYaw) > 0.99999) {
      // Gimbal lock: yaw at ±90°, pitch and roll are coupled.
      return {
        pitch: 0,
        yaw: Math.sign(sinYaw) * (Math.PI / 2),
        roll: Math.atan2(2 * (x * y - w * z), 1 - 2 * (x * x + z * z)),
      };
    }
    return {
      pitch: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
      yaw: Math.asin(sinYaw),
      roll: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// BoneRotations — raw VMC input, keyed by source app bone name
// ──────────────────────────────────────────────────────────────────────────────

export class BoneRotations {
  private readonly _bones: Map<string, Quaternion>;

  constructor(entries: Iterable<readonly [string, Quaternion]> = []) {
    this._bones = new Map(entries);
  }

  static fromRecord(
    rec: Record<string, readonly [number, number, number, number]>
  ): BoneRotations {
    return new BoneRotations(
      Object.entries(rec).map(([k, v]) => [k, Quaternion.fromArray(v)] as const)
    );
  }

  get(bone: string): Quaternion | undefined {
    return this._bones.get(bone);
  }
  has(bone: string): boolean {
    return this._bones.has(bone);
  }
  get size(): number {
    return this._bones.size;
  }
  entries(): IterableIterator<[string, Quaternion]> {
    return this._bones.entries();
  }
  keys(): IterableIterator<string> {
    return this._bones.keys();
  }

  map(fn: (q: Quaternion, bone: string) => Quaternion): BoneRotations {
    return new BoneRotations(
      Array.from(this._bones.entries()).map(([b, q]) => [b, fn(q, b)] as const)
    );
  }

  filter(fn: (bone: string, q: Quaternion) => boolean): BoneRotations {
    return new BoneRotations(
      Array.from(this._bones.entries()).filter(([b, q]) => fn(b, q))
    );
  }

  toRecord(): Record<string, [number, number, number, number]> {
    const out: Record<string, [number, number, number, number]> = {};
    for (const [b, q] of this._bones) out[b] = q.toArray();
    return out;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// NormalizedPose — VRM-mapped, coordinate-corrected bone rotations
// ──────────────────────────────────────────────────────────────────────────────

export class NormalizedPose {
  private readonly _bones: Map<VRMBoneName, Quaternion>;

  constructor(entries: Iterable<readonly [VRMBoneName, Quaternion]> = []) {
    this._bones = new Map(entries);
  }

  get(bone: VRMBoneName): Quaternion | undefined {
    return this._bones.get(bone);
  }
  has(bone: VRMBoneName): boolean {
    return this._bones.has(bone);
  }
  get size(): number {
    return this._bones.size;
  }
  entries(): IterableIterator<[VRMBoneName, Quaternion]> {
    return this._bones.entries();
  }
  keys(): IterableIterator<VRMBoneName> {
    return this._bones.keys();
  }

  with(bone: VRMBoneName, q: Quaternion): NormalizedPose {
    const next = new Map(this._bones);
    next.set(bone, q);
    return new NormalizedPose(next);
  }

  map(fn: (q: Quaternion, bone: VRMBoneName) => Quaternion): NormalizedPose {
    return new NormalizedPose(
      Array.from(this._bones.entries()).map(([b, q]) => [b, fn(q, b)] as const)
    );
  }

  toRecord(): Record<string, [number, number, number, number]> {
    const out: Record<string, [number, number, number, number]> = {};
    for (const [b, q] of this._bones) out[b] = q.toArray();
    return out;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Blendshapes — VRM expression weights, clamped to [0, 1]
// ──────────────────────────────────────────────────────────────────────────────

export class Blendshapes {
  private readonly _values: Map<string, number>;

  constructor(entries: Iterable<readonly [string, number]> = []) {
    this._values = new Map(entries);
  }

  static fromRecord(rec: Record<string, number>): Blendshapes {
    return new Blendshapes(Object.entries(rec));
  }

  get(name: string): number {
    return this._values.get(name) ?? 0;
  }
  has(name: string): boolean {
    return this._values.has(name);
  }
  get size(): number {
    return this._values.size;
  }
  entries(): IterableIterator<[string, number]> {
    return this._values.entries();
  }

  with(name: string, value: number): Blendshapes {
    const next = new Map(this._values);
    next.set(name, Math.max(0, Math.min(1, value)));
    return new Blendshapes(next);
  }

  map(fn: (value: number, name: string) => number): Blendshapes {
    return new Blendshapes(
      Array.from(this._values.entries()).map(([n, v]) => [n, fn(v, n)] as const)
    );
  }

  toRecord(): Record<string, number> {
    return Object.fromEntries(this._values);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// InterceptorFrame — opaque token passed through the pose interceptor chain
// ──────────────────────────────────────────────────────────────────────────────

export interface InterceptorFrame {
  /** Scene node the broadcast is addressed to. */
  readonly nodeId: string;
  /** Pose at the point this interceptor was invoked. */
  readonly pose: NormalizedPose;
  /** Priority of the on_pose_broadcast node that produced this frame. */
  readonly priority: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// PoseFrame — fully assembled frame, wire format for server → client broadcast
// ──────────────────────────────────────────────────────────────────────────────

export class PoseFrame {
  constructor(
    public readonly behaviorId: string,
    public readonly pose: NormalizedPose,
    public readonly blendshapes: Blendshapes,
    public readonly timestamp: number
  ) {}

  toWire(): {
    bones: Record<string, [number, number, number, number]>;
    blendshapes: Record<string, number>;
  } {
    return {
      bones: this.pose.toRecord(),
      blendshapes: this.blendshapes.toRecord(),
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Event<T> — push signal wrapper
// ──────────────────────────────────────────────────────────────────────────────

export interface Event<T> {
  readonly payload: T;
  readonly timestamp: number;
}

export function mkEvent<T>(payload: T, timestamp = Date.now()): Event<T> {
  return { payload, timestamp };
}

// ──────────────────────────────────────────────────────────────────────────────
// Signal type system — port types and connection safety
// ──────────────────────────────────────────────────────────────────────────────

export interface SignalTypeMap {
  BoneRotations: BoneRotations;
  NormalizedPose: NormalizedPose;
  Blendshapes: Blendshapes;
  /** Raw ARKit 52-shape weights before any VRM expression mapping. */
  ArkitBlendshapes: Blendshapes;
  PoseFrame: PoseFrame;
  Float: number;
  Bool: boolean;
  Trigger: void;
  /** General-purpose string value (IDs, names). */
  String: string;
  /** A component's full config JSON, pulled as a value. */
  BehaviorConfig: Record<string, unknown>;
  /**
   * Reference to a scene NODE — carried as the node's bare id string at runtime.
   * The narrow counterpart of `SceneEntity` (a `SceneNode` is assignable to a
   * `SceneEntity` input, but not vice versa). See `isAssignable`.
   */
  SceneNode: string;
  /** Reference to a compose LAYER — its bare id string at runtime. Narrow
   *  counterpart of `SceneEntity`, like `SceneNode`. */
  ComposeLayer: string;
  /** ARKit→target mapping table: shape name → [(targetName, weight), ...] */
  MappingTable: Record<string, [string, number][]> | null;
  /** Opaque token passed through the pose interceptor chain. */
  InterceptorFrame: InterceptorFrame;
  /** A single unit quaternion rotation. */
  Quaternion: Quaternion;
  /** Wildcard — compatible with any other type for generic nodes. */
  Any: unknown;
  /** Raw MediaPipe landmark array (face=478, hand=21, pose=33 points). */
  LandmarkList: Array<{ x: number; y: number; z: number; visibility?: number }>;
  /** IK end-effector targets for a single frame, ready for frontend solve. */
  IkTargets: import('./types.js').IkTargetFrame;
  /**
   * Reference to a configured overlive login account (Twitch / StreamElements).
   * Carried as the account row id string at runtime; the frontend port editor
   * renders a dropdown of the project's accounts when nothing is wired in.
   */
  Account: string;
  /**
   * Payload emitted by `spawn_clip`. Carries the ids of the ephemeral entity
   * that was cloned and the ephemeral clip duplicate now playing on it, plus
   * which kind of entity was spawned. `set_*_param` nodes accept a
   * `Event<SpawnRef>` on a `spawnRef` input to retarget the call to the
   * tmp entity for that fire. See dev-notes/modules/spawn.md.
   */
  SpawnRef: {
    tmpNodeId: string;
    tmpClipId: string;
    kind: 'scene_node' | 'compose_layer';
  };
  /**
   * Reference to a scene entity — EITHER a scene node or a compose layer —
   * carried as that entity's bare id string at runtime (ids are unique across
   * both, so the kind isn't needed at runtime). The generic supertype: a
   * `SceneNode` or `ComposeLayer` output is assignable into a `SceneEntity`
   * input (see `isAssignable`). Used as the `scope` input on `set_data` to target
   * which consumer a published field-set is visible to (the consumer listens on
   * its own id). The port editor renders a node/layer dropdown when nothing is
   * wired in.
   */
  SceneEntity: string;
}

export type SignalTypeName = keyof SignalTypeMap;

// ──────────────────────────────────────────────────────────────────────────────
// SignalNodeClass — structural interface expected by the engine (Phase 2)
//
// A node class is a constructor for a `Node` subclass (see node.ts), carrying a
// static `kind`. Ports are declared as decorated members and harvested at
// class-definition time by `@SignalNode` (no static inputPorts/outputPorts arrays).
// An optional static `inferPorts` lets a node compute its resolved ports from its
// connected inputs; ordinary nodes omit it and fall back to lifting their static
// port declarations.
// ──────────────────────────────────────────────────────────────────────────────

import type { Node, InferCtx, InferResult } from './node.js';
import { harvestPorts } from './node.js';
import type { ResolvedType, Transport } from './signal_types.js';

export interface SignalNodeClass {
  readonly kind: string;
  /** Construct a fresh node instance (the engine then calls `instance.bind(...)`). */
  new (): Node;
  /** Optional shape inference from connected inputs (pack/unpack/queue). */
  inferPorts?(ctx: InferCtx): InferResult;
}

// ──────────────────────────────────────────────────────────────────────────────
// @SignalNode decorator — attaches display metadata to a node class
//
// Metadata is stored in a module-level WeakMap keyed by the class constructor.
// getNodeDisplay(cls) retrieves it without any Symbol.metadata dependency.
// ──────────────────────────────────────────────────────────────────────────────

/** Display properties rendered in the React Flow graph editor. */
export interface NodeDisplay {
  /** Human-readable node label shown in the canvas. */
  label: string;
  /** Short description shown in the node palette tooltip. */
  description?: string;
  /** Category tags — a node appears in every tab whose tag it carries. */
  tags: string[];
  /** Hex fill colour for the node header in the canvas. */
  color: string;
  /** If true the node is auto-wired by the system and hidden from the user palette. */
  internal?: boolean;
}

/** Per-SignalTypeName edge/handle colour used in the React Flow canvas. */
export const SIGNAL_TYPE_COLORS: Record<SignalTypeName, string> = {
  BoneRotations: '#6a9fb5',
  NormalizedPose: '#5ba45b',
  Blendshapes: '#b58a3a',
  ArkitBlendshapes: '#c47a20',
  PoseFrame: '#7a5baf',
  Float: '#a0a0a0',
  Bool: '#c87070',
  Trigger: '#888888',
  String: '#7ab8c8',
  BehaviorConfig: '#8a6aaf',
  SceneNode: '#6a8aaf',
  ComposeLayer: '#6aaf9a',
  MappingTable: '#a07050',
  InterceptorFrame: '#9a5a8a',
  Quaternion: '#5a9a7a',
  LandmarkList: '#7a9a6a',
  IkTargets: '#a06a9a',
  Account: '#9146ff',
  SpawnRef: '#c97a3a',
  SceneEntity: '#4aa0a0',
  Any: '#888888',
};

const _displayMap = new WeakMap<object, NodeDisplay>();

/**
 * Class decorator. Co-locates display metadata with the node definition AND harvests
 * the port declarations buffered by the member decorators (`@eventIn`/`@valueIn`/…).
 * It must run after the member decorators (class decorators always do) and shares the
 * same `ctx.metadata` buffer, so by the time it runs every port is registered.
 *
 * ```ts
 * @SignalNode({ label: 'Body Calibration', tags: ['calibration'], color: '#4a6a9f' })
 * export class BodyCalibration extends Node { ... }
 * ```
 */
export function SignalNode(display: NodeDisplay) {
  return function (cls: object, ctx: ClassDecoratorContext): void {
    _displayMap.set(cls, display);
    harvestPorts(cls, ctx.metadata);
  };
}

/** Returns the NodeDisplay attached by @SignalNode, or undefined if not decorated. */
export function getNodeDisplay(cls: object): NodeDisplay | undefined {
  return _displayMap.get(cls);
}

// ──────────────────────────────────────────────────────────────────────────────
// Graph descriptor — shared data shape for both implicit (code-defined) and
// explicit (DB-persisted) graphs. The engine instantiates from it; the React
// Flow canvas renders it.
// ──────────────────────────────────────────────────────────────────────────────

export interface GraphNodeDescriptor {
  /** Unique within the graph. */
  id: string;
  /** Must match a registered SignalNodeClass.kind. */
  kind: string;
  /** Canvas position for React Flow. */
  position: { x: number; y: number };
  /** Default config values, merged with any user-stored nodeConfig overrides. */
  defaultConfig?: Record<string, unknown>;
}

export interface GraphEdgeDescriptor {
  fromNodeId: string;
  fromPort: string;
  toNodeId: string;
  toPort: string;
  /** Defaults to 'event'. Value = pulled once per (to, port). List = multiple sources fan into an array. */
  kind?: 'event' | 'value' | 'list';
}

export interface GraphDescriptor {
  /** Unique across all graphs in the system. */
  id: string;
  label: string;
  /** Whether the graph topology is editable by the user. */
  readonly: boolean;
  nodes: GraphNodeDescriptor[];
  edges: GraphEdgeDescriptor[];
}

// ──────────────────────────────────────────────────────────────────────────────
// NodeKindMeta — serialisable node kind descriptor served by the API
// Used by the frontend node palette and canvas to render without importing
// backend node classes directly.
// ──────────────────────────────────────────────────────────────────────────────

/** Live state of a single node, returned by the monitoring API. */
export interface NodeStateSnapshot {
  lastExecutedAt: number | null;
  /** Last pulled / emitted scalar values (value ports + small event payloads). */
  portValues: Record<string, unknown>;
  /** Current config object for the node. */
  config: unknown;
}

/** Live state of a single event edge. Key format: `fromId:fromPort:toId:toPort`. */
export interface EdgeStateSnapshot {
  lastFiredAt: number | null;
  lastValue: unknown;
}

/** Combined graph monitoring snapshot. */
export interface GraphStateSnapshot {
  nodes: Record<string, NodeStateSnapshot>;
  edges: Record<string, EdgeStateSnapshot>;
}

/**
 * A node port as served to the frontend. Carries the port's STATIC declared shape:
 * its resolved type (transport folded in) plus the leaf type tag + transport for
 * rendering. The editor recomputes per-instance dynamic ports via shared inference;
 * this is the per-kind baseline (what `defaultInfer` would produce).
 */
export interface NodePortMeta {
  name: string;
  /** Resolved structural type (transport folded into the constructor). */
  resolved: ResolvedType;
  /** Leaf data-type tag (for colour lookup in SIGNAL_TYPE_COLORS). */
  typeTag: SignalTypeName;
  /** Derived transport: 'event' | 'value' | 'list'. */
  transport: Transport;
}

export interface NodeKindMeta {
  kind: string;
  inputPorts: NodePortMeta[];
  outputPorts: NodePortMeta[];
  display: NodeDisplay | undefined;
  /** True if the kind has a custom inferPorts (ports may grow/shrink at edit time). */
  dynamic?: boolean;
}
