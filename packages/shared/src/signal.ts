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
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'jaw',
  'leftEye', 'rightEye',
  'leftShoulder',  'leftUpperArm',  'leftLowerArm',  'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg',  'leftLowerLeg',  'leftFoot',  'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
  'leftThumbMetacarpal',  'leftThumbProximal',  'leftThumbDistal',
  'leftIndexProximal',    'leftIndexIntermediate',    'leftIndexDistal',
  'leftMiddleProximal',   'leftMiddleIntermediate',   'leftMiddleDistal',
  'leftRingProximal',     'leftRingIntermediate',     'leftRingDistal',
  'leftLittleProximal',   'leftLittleIntermediate',   'leftLittleDistal',
  'rightThumbMetacarpal', 'rightThumbProximal', 'rightThumbDistal',
  'rightIndexProximal',   'rightIndexIntermediate',   'rightIndexDistal',
  'rightMiddleProximal',  'rightMiddleIntermediate',  'rightMiddleDistal',
  'rightRingProximal',    'rightRingIntermediate',    'rightRingDistal',
  'rightLittleProximal',  'rightLittleIntermediate',  'rightLittleDistal',
] as const

export type VRMBoneName = typeof VRM_BONE_NAMES[number]

// ──────────────────────────────────────────────────────────────────────────────
// Quaternion — immutable unit quaternion with full algebra
// ──────────────────────────────────────────────────────────────────────────────

export class Quaternion {
  constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly z: number,
    public readonly w: number,
  ) {}

  static readonly IDENTITY = new Quaternion(0, 0, 0, 1)

  static fromArray(a: readonly [number, number, number, number]): Quaternion {
    return new Quaternion(a[0], a[1], a[2], a[3])
  }

  toArray(): [number, number, number, number] {
    return [this.x, this.y, this.z, this.w]
  }

  get magnitudeSquared(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w
  }

  get isValid(): boolean { return this.magnitudeSquared > 1e-9 }

  normalize(): Quaternion {
    const len = Math.sqrt(this.magnitudeSquared)
    if (len < 1e-9) return Quaternion.IDENTITY
    return new Quaternion(this.x / len, this.y / len, this.z / len, this.w / len)
  }

  invert(): Quaternion {
    const m2 = this.magnitudeSquared
    if (m2 < 1e-9) return Quaternion.IDENTITY
    const s = 1 / m2
    return new Quaternion(-this.x * s, -this.y * s, -this.z * s, this.w * s)
  }

  multiply(rhs: Quaternion): Quaternion {
    const { x: ax, y: ay, z: az, w: aw } = this
    const { x: bx, y: by, z: bz, w: bw } = rhs
    return new Quaternion(
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    )
  }

  premultiply(lhs: Quaternion): Quaternion { return lhs.multiply(this) }
}

// ──────────────────────────────────────────────────────────────────────────────
// BoneRotations — raw VMC input, keyed by source app bone name
// ──────────────────────────────────────────────────────────────────────────────

export class BoneRotations {
  private readonly _bones: Map<string, Quaternion>

  constructor(entries: Iterable<readonly [string, Quaternion]> = []) {
    this._bones = new Map(entries)
  }

  static fromRecord(rec: Record<string, readonly [number, number, number, number]>): BoneRotations {
    return new BoneRotations(
      Object.entries(rec).map(([k, v]) => [k, Quaternion.fromArray(v)] as const),
    )
  }

  get(bone: string): Quaternion | undefined { return this._bones.get(bone) }
  has(bone: string): boolean { return this._bones.has(bone) }
  get size(): number { return this._bones.size }
  entries(): IterableIterator<[string, Quaternion]> { return this._bones.entries() }
  keys(): IterableIterator<string> { return this._bones.keys() }

  map(fn: (q: Quaternion, bone: string) => Quaternion): BoneRotations {
    return new BoneRotations(
      Array.from(this._bones.entries()).map(([b, q]) => [b, fn(q, b)] as const),
    )
  }

  filter(fn: (bone: string, q: Quaternion) => boolean): BoneRotations {
    return new BoneRotations(
      Array.from(this._bones.entries()).filter(([b, q]) => fn(b, q)),
    )
  }

  toRecord(): Record<string, [number, number, number, number]> {
    const out: Record<string, [number, number, number, number]> = {}
    for (const [b, q] of this._bones) out[b] = q.toArray()
    return out
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// NormalizedPose — VRM-mapped, coordinate-corrected bone rotations
// ──────────────────────────────────────────────────────────────────────────────

export class NormalizedPose {
  private readonly _bones: Map<VRMBoneName, Quaternion>

  constructor(entries: Iterable<readonly [VRMBoneName, Quaternion]> = []) {
    this._bones = new Map(entries)
  }

  get(bone: VRMBoneName): Quaternion | undefined { return this._bones.get(bone) }
  has(bone: VRMBoneName): boolean { return this._bones.has(bone) }
  get size(): number { return this._bones.size }
  entries(): IterableIterator<[VRMBoneName, Quaternion]> { return this._bones.entries() }
  keys(): IterableIterator<VRMBoneName> { return this._bones.keys() }

  with(bone: VRMBoneName, q: Quaternion): NormalizedPose {
    const next = new Map(this._bones)
    next.set(bone, q)
    return new NormalizedPose(next)
  }

  map(fn: (q: Quaternion, bone: VRMBoneName) => Quaternion): NormalizedPose {
    return new NormalizedPose(
      Array.from(this._bones.entries()).map(([b, q]) => [b, fn(q, b)] as const),
    )
  }

  toRecord(): Record<string, [number, number, number, number]> {
    const out: Record<string, [number, number, number, number]> = {}
    for (const [b, q] of this._bones) out[b] = q.toArray()
    return out
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Blendshapes — VRM expression weights, clamped to [0, 1]
// ──────────────────────────────────────────────────────────────────────────────

export class Blendshapes {
  private readonly _values: Map<string, number>

  constructor(entries: Iterable<readonly [string, number]> = []) {
    this._values = new Map(entries)
  }

  static fromRecord(rec: Record<string, number>): Blendshapes {
    return new Blendshapes(Object.entries(rec))
  }

  get(name: string): number { return this._values.get(name) ?? 0 }
  has(name: string): boolean { return this._values.has(name) }
  get size(): number { return this._values.size }
  entries(): IterableIterator<[string, number]> { return this._values.entries() }

  with(name: string, value: number): Blendshapes {
    const next = new Map(this._values)
    next.set(name, Math.max(0, Math.min(1, value)))
    return new Blendshapes(next)
  }

  map(fn: (value: number, name: string) => number): Blendshapes {
    return new Blendshapes(
      Array.from(this._values.entries()).map(([n, v]) => [n, fn(v, n)] as const),
    )
  }

  toRecord(): Record<string, number> { return Object.fromEntries(this._values) }
}

// ──────────────────────────────────────────────────────────────────────────────
// InterceptorFrame — opaque token passed through the pose interceptor chain
// ──────────────────────────────────────────────────────────────────────────────

export interface InterceptorFrame {
  /** Scene node the broadcast is addressed to. */
  readonly nodeId:   string
  /** Pose at the point this interceptor was invoked. */
  readonly pose:     NormalizedPose
  /** Priority of the on_pose_broadcast node that produced this frame. */
  readonly priority: number
}

// ──────────────────────────────────────────────────────────────────────────────
// PoseFrame — fully assembled frame, wire format for server → client broadcast
// ──────────────────────────────────────────────────────────────────────────────

export class PoseFrame {
  constructor(
    public readonly componentId: string,
    public readonly pose: NormalizedPose,
    public readonly blendshapes: Blendshapes,
    public readonly timestamp: number,
  ) {}

  toWire(): {
    bones: Record<string, [number, number, number, number]>
    blendshapes: Record<string, number>
  } {
    return { bones: this.pose.toRecord(), blendshapes: this.blendshapes.toRecord() }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Event<T> — push signal wrapper
// ──────────────────────────────────────────────────────────────────────────────

export interface Event<T> {
  readonly payload: T
  readonly timestamp: number
}

export function mkEvent<T>(payload: T, timestamp = Date.now()): Event<T> {
  return { payload, timestamp }
}

// ──────────────────────────────────────────────────────────────────────────────
// Signal type system — port types and connection safety
// ──────────────────────────────────────────────────────────────────────────────

export interface SignalTypeMap {
  BoneRotations:    BoneRotations
  NormalizedPose:   NormalizedPose
  Blendshapes:      Blendshapes
  /** Raw ARKit 52-shape weights before any VRM expression mapping. */
  ArkitBlendshapes: Blendshapes
  PoseFrame:        PoseFrame
  Float:            number
  Bool:             boolean
  Trigger:          void
  /** General-purpose string value (IDs, names). */
  String:           string
  /** A component's full config JSON, pulled as a value. */
  ComponentConfig:  Record<string, unknown>
  /** A scene entity / node ID. */
  EntityId:         string
  /** ARKit→target mapping table: shape name → [(targetName, weight), ...] */
  MappingTable:     Record<string, [string, number][]> | null
  /** Opaque token passed through the pose interceptor chain. */
  InterceptorFrame: InterceptorFrame
  /** A single unit quaternion rotation. */
  Quaternion:       Quaternion
  /** Wildcard — compatible with any other type for generic nodes. */
  Any:              unknown
  /** Raw MediaPipe landmark array (face=478, hand=21, pose=33 points). */
  LandmarkList:     Array<{ x: number; y: number; z: number; visibility?: number }>
  /** IK end-effector targets for a single frame, ready for frontend solve. */
  IkTargets:        import('./types.js').IkTargetFrame
  /**
   * Reference to a configured overlive login account (Twitch / StreamElements).
   * Carried as the account row id string at runtime; the frontend port editor
   * renders a dropdown of the project's accounts when nothing is wired in.
   */
  Account:          string
}

export type SignalTypeName = keyof SignalTypeMap

export type PortKind = 'event' | 'value' | 'list'

export type PortDecl<
  N extends string         = string,
  T extends SignalTypeName = SignalTypeName,
  K extends PortKind       = PortKind,
> = { readonly name: N; readonly type: T; readonly kind: K }

export function eventPort<N extends string, T extends SignalTypeName>(
  name: N, type: T,
): PortDecl<N, T, 'event'> { return { name, type, kind: 'event' } }

export function valuePort<N extends string, T extends SignalTypeName>(
  name: N, type: T,
): PortDecl<N, T, 'value'> { return { name, type, kind: 'value' } }

/** A list port accepts multiple incoming value connections and delivers them as an array. */
export function listPort<N extends string, T extends SignalTypeName>(
  name: N, type: T,
): PortDecl<N, T, 'list'> { return { name, type, kind: 'list' } }

type PortRuntimeType<T extends SignalTypeName, K extends PortKind> =
  K extends 'event' ? Event<SignalTypeMap[T]> :
  K extends 'list'  ? Array<SignalTypeMap[T]> :
  SignalTypeMap[T]

export type PortsToRecord<Ports extends ReadonlyArray<PortDecl>> = {
  [P in Ports[number] as P['name']]: PortRuntimeType<P['type'], P['kind']>
}

// ──────────────────────────────────────────────────────────────────────────────
// SignalNode class helpers — InputsOf / OutputsOf
//
// Used as execute() parameter annotations on class-based node definitions.
//   InputsOf<typeof MyNode>  → { portName: Event<DataType>, ... }
//   OutputsOf<typeof MyNode> → { portName: Event<DataType>, ... }
// ──────────────────────────────────────────────────────────────────────────────

export type InputsOf<T extends { readonly inputPorts: ReadonlyArray<PortDecl> }> =
  PortsToRecord<T['inputPorts']>

export type OutputsOf<T extends { readonly outputPorts: ReadonlyArray<PortDecl> }> =
  PortsToRecord<T['outputPorts']>

/**
 * Passed as the third argument to every node's execute().
 * Provides access to per-node persistent state and the port that triggered
 * this execution (useful for trigger-event branches).
 */
export interface NodeExecutionContext {
  /** Which input port name caused this execution. */
  triggeredPort: string
  /** Load this node's persisted state (e.g. calibration offsets). */
  getState<T = unknown>(): T
  /** Persist new state for this node. */
  setState(state: unknown): void
}

// ──────────────────────────────────────────────────────────────────────────────
// SignalNodeClass — structural interface expected by the engine
//
// Any class carrying static kind, inputPorts, outputPorts and execute satisfies
// this type. The engine uses it as the erased boundary; individual nodes use
// the stricter InputsOf/OutputsOf annotations for compile-time safety.
// ──────────────────────────────────────────────────────────────────────────────

export interface SignalNodeClass {
  readonly kind:        string
  readonly inputPorts:  ReadonlyArray<PortDecl>
  readonly outputPorts: ReadonlyArray<PortDecl>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(inputs: any, config: unknown, ctx: NodeExecutionContext): Record<string, unknown>
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
  label: string
  /** Short description shown in the node palette tooltip. */
  description?: string
  /** Category tags — a node appears in every tab whose tag it carries. */
  tags: string[]
  /** Hex fill colour for the node header in the canvas. */
  color: string
  /** If true the node is auto-wired by the system and hidden from the user palette. */
  internal?: boolean
}

/** Per-SignalTypeName edge/handle colour used in the React Flow canvas. */
export const SIGNAL_TYPE_COLORS: Record<SignalTypeName, string> = {
  BoneRotations:    '#6a9fb5',
  NormalizedPose:   '#5ba45b',
  Blendshapes:      '#b58a3a',
  ArkitBlendshapes: '#c47a20',
  PoseFrame:        '#7a5baf',
  Float:           '#a0a0a0',
  Bool:            '#c87070',
  Trigger:         '#888888',
  String:          '#7ab8c8',
  ComponentConfig: '#8a6aaf',
  EntityId:        '#6a8aaf',
MappingTable:      '#a07050',
  InterceptorFrame:  '#9a5a8a',
  Quaternion:        '#5a9a7a',
  LandmarkList:      '#7a9a6a',
  IkTargets:         '#a06a9a',
  Account:           '#9146ff',
  Any:               '#888888',
}

const _displayMap = new WeakMap<object, NodeDisplay>()

/**
 * Class decorator. Co-locate display metadata with the node definition:
 *
 * ```ts
 * @SignalNode({ label: 'Body Calibration', tags: ['calibration'], color: '#4a6a9f' })
 * export class BodyCalibration { ... }
 * ```
 */
export function SignalNode(display: NodeDisplay) {
  return function (cls: object, _ctx: ClassDecoratorContext): void {
    _displayMap.set(cls, display)
  }
}

/** Returns the NodeDisplay attached by @SignalNode, or undefined if not decorated. */
export function getNodeDisplay(cls: object): NodeDisplay | undefined {
  return _displayMap.get(cls)
}

// ──────────────────────────────────────────────────────────────────────────────
// Graph descriptor — shared data shape for both implicit (code-defined) and
// explicit (DB-persisted) graphs. The engine instantiates from it; the React
// Flow canvas renders it.
// ──────────────────────────────────────────────────────────────────────────────

export interface GraphNodeDescriptor {
  /** Unique within the graph. */
  id:       string
  /** Must match a registered SignalNodeClass.kind. */
  kind:     string
  /** Canvas position for React Flow. */
  position: { x: number; y: number }
  /** Default config values, merged with any user-stored nodeConfig overrides. */
  defaultConfig?: Record<string, unknown>
}

export interface GraphEdgeDescriptor {
  fromNodeId: string
  fromPort:   string
  toNodeId:   string
  toPort:     string
  /** Defaults to 'event'. Value = pulled once per (to, port). List = multiple sources fan into an array. */
  kind?:      'event' | 'value' | 'list'
}

export interface GraphDescriptor {
  /** Unique across all graphs in the system. */
  id:     string
  label:  string
  /** Whether the graph topology is editable by the user. */
  readonly: boolean
  nodes:  GraphNodeDescriptor[]
  edges:  GraphEdgeDescriptor[]
}

// ──────────────────────────────────────────────────────────────────────────────
// NodeKindMeta — serialisable node kind descriptor served by the API
// Used by the frontend node palette and canvas to render without importing
// backend node classes directly.
// ──────────────────────────────────────────────────────────────────────────────

/** Live state of a single node, returned by the monitoring API. */
export interface NodeStateSnapshot {
  lastExecutedAt: number | null
  /** Last pulled / emitted scalar values (value ports + small event payloads). */
  portValues: Record<string, unknown>
  /** Current config object for the node. */
  config: unknown
}

/** Live state of a single event edge. Key format: `fromId:fromPort:toId:toPort`. */
export interface EdgeStateSnapshot {
  lastFiredAt: number | null
  lastValue:   unknown
}

/** Combined graph monitoring snapshot. */
export interface GraphStateSnapshot {
  nodes: Record<string, NodeStateSnapshot>
  edges: Record<string, EdgeStateSnapshot>
}

export interface NodePortMeta {
  name:     string
  type:     string   // SignalTypeName
  portKind: string   // PortKind
}

export interface NodeKindMeta {
  kind:        string
  inputPorts:  NodePortMeta[]
  outputPorts: NodePortMeta[]
  display:     NodeDisplay | undefined
}

// ──────────────────────────────────────────────────────────────────────────────
// PortConnection — runtime edge with type information (for validation)
// ──────────────────────────────────────────────────────────────────────────────

export interface PortConnection {
  fromNodeId: string
  fromPort:   string
  fromType:   SignalTypeName
  fromKind:   PortKind
  toNodeId:   string
  toPort:     string
  toType:     SignalTypeName
  toKind:     PortKind
}

export function portsCompatible(
  from: Pick<PortConnection, 'fromType' | 'fromKind'>,
  to:   Pick<PortConnection, 'toType'   | 'toKind'>,
): boolean {
  // A value output can feed into a list input (many-to-one fan-in).
  const effectiveFromKind = from.fromKind === 'value' && to.toKind === 'list' ? 'list' : from.fromKind
  if (effectiveFromKind !== to.toKind) return false
  // ComponentConfig and Any are wildcard types — compatible with any value/list port.
  if (from.fromType === 'ComponentConfig' || from.fromType === 'Any') return true
  if (to.toType === 'Any') return true
  return from.fromType === to.toType
}
