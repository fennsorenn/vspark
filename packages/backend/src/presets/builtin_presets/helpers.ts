// Shared builders for the built-in preset library. Built-in presets are
// authored as plain objects in the same `vspark.preset.v2` shape the
// serializer emits (the backend bundle has no JSON-module support), so they
// flow through the normal instantiate path. They are read-only.
//
// Id portability: any reference to another entity in the SAME payload that
// lives INSIDE a nested JSON blob (a graph descriptor's `defaultConfig`, a
// layer/node config, properties, …) must be written as a `__preset:<tag>`
// token, where `<tag>` is that entity's `presetId`. On import the substituter
// rewrites the token to the freshly minted real id. Structured reference
// fields (`parentPresetId`, `ownerPresetId`, `targetPresetId`, …) instead use
// the bare `presetId` and are resolved directly by the deserializer. See
// packages/backend/src/presets/substitute.ts + deserialize.ts.

export interface BuiltinPreset {
  id: string;
  name: string;
  description: string;
  rootKind: 'scene_node' | 'compose_layer';
  payload: Record<string, unknown>;
}

/** Reference an entity (by its presetId) from inside a nested JSON blob. */
export function ref(presetId: string): string {
  return `__preset:${presetId}`;
}

// ── Transform / scene-node bag ────────────────────────────────────────────

export const identity = {
  type: 'transform',
  x: 0,
  y: 0,
  z: 0,
  rx: 0,
  ry: 0,
  rz: 0,
  sx: 1,
  sy: 1,
  sz: 1,
};

export function transform(
  x: number,
  y: number,
  z: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { ...identity, x, y, z, ...extra };
}

export interface SceneNodeOpts {
  hidden?: boolean;
  properties?: Record<string, unknown>;
  components?: unknown[];
  cameraEffects?: unknown[];
}

export function sceneNode(
  presetId: string,
  parentPresetId: string | null,
  name: string,
  kind: string,
  componentsBag: Record<string, unknown>,
  opts: SceneNodeOpts = {}
): Record<string, unknown> {
  return {
    presetId,
    parentPresetId,
    name,
    kind,
    filePresetAssetId: null,
    boneAttachment: null,
    hidden: opts.hidden ?? false,
    properties: opts.properties ?? {},
    componentsBag,
    components: opts.components ?? [],
    cameraEffects: opts.cameraEffects ?? [],
  };
}

// ── Compose layers ────────────────────────────────────────────────────────

export interface ComposeLayerOpts {
  config?: Record<string, unknown>;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  anchorH?: 'left' | 'right';
  anchorV?: 'top' | 'bottom';
  sceneOrder?: number;
  cameraOrder?: number;
  visible?: boolean;
}

export function composeLayer(
  presetId: string,
  parentPresetId: string | null,
  name: string,
  kind: string,
  opts: ComposeLayerOpts = {}
): Record<string, unknown> {
  return {
    presetId,
    parentPresetId,
    name,
    kind,
    assetPresetAssetId: null,
    config: opts.config ?? {},
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    width: opts.width ?? 400,
    height: opts.height ?? 200,
    rotation: opts.rotation ?? 0,
    anchorH: opts.anchorH ?? 'left',
    anchorV: opts.anchorV ?? 'top',
    // Negative scene_order = in front of the 3D render (overlay).
    sceneOrder: opts.sceneOrder ?? -1,
    cameraOrder: opts.cameraOrder ?? 0,
    visible: opts.visible ?? true,
    cameraNodePresetId: null,
  };
}

// ── Signal-graph descriptor builders ──────────────────────────────────────

export type EdgeKind = 'event' | 'value' | 'list';

export interface GNode {
  id: string;
  kind: string;
  position: { x: number; y: number };
  defaultConfig?: Record<string, unknown>;
}

export interface GEdge {
  fromNodeId: string;
  fromPort: string;
  toNodeId: string;
  toPort: string;
  kind: EdgeKind;
}

/** Build a graph node. Position is auto-laid-out by `index` (column) so the
 *  authored descriptor opens tidily in the editor; tweak later if needed. */
export function gnode(
  id: string,
  kind: string,
  column: number,
  row: number,
  defaultConfig?: Record<string, unknown>
): GNode {
  return {
    id,
    kind,
    position: { x: column * 280, y: row * 160 },
    ...(defaultConfig ? { defaultConfig } : {}),
  };
}

export function edge(
  fromNodeId: string,
  fromPort: string,
  toNodeId: string,
  toPort: string,
  kind: EdgeKind
): GEdge {
  return { fromNodeId, fromPort, toNodeId, toPort, kind };
}

export interface LogicEntry {
  presetId: string;
  ownerKind: 'scene_node' | 'compose_layer';
  ownerPresetId: string;
  name: string;
  enabled: boolean;
  descriptor: {
    id: string;
    label: string;
    readonly: boolean;
    nodes: GNode[];
    edges: GEdge[];
  };
  nodeState: Record<string, unknown>;
}

export function graph(
  presetId: string,
  ownerKind: 'scene_node' | 'compose_layer',
  ownerPresetId: string,
  name: string,
  nodes: GNode[],
  edges: GEdge[],
  enabled = true
): LogicEntry {
  return {
    presetId,
    ownerKind,
    ownerPresetId,
    name,
    enabled,
    descriptor: {
      id: `builtin-${presetId}`,
      label: name,
      readonly: false,
      nodes,
      edges,
    },
    nodeState: {},
  };
}

// ── Track-clip builders ───────────────────────────────────────────────────

export interface Keyframe {
  presetId: string;
  t: number;
  value: number;
  easing: string;
  inHandleTFraction: number | null;
  inHandleVFraction: number | null;
  outHandleTFraction: number | null;
  outHandleVFraction: number | null;
}

export function kf(
  presetId: string,
  t: number,
  value: number,
  easing = 'linear'
): Keyframe {
  return {
    presetId,
    t,
    value,
    easing,
    inHandleTFraction: null,
    inHandleVFraction: null,
    outHandleTFraction: null,
    outHandleVFraction: null,
  };
}

export interface Lane {
  presetId: string;
  targetKind: 'scene_node' | 'compose_layer';
  targetPresetId: string;
  paramPath: string;
  defaultValue: number;
  keyframes: Keyframe[];
}

export function lane(
  presetId: string,
  targetKind: 'scene_node' | 'compose_layer',
  targetPresetId: string,
  paramPath: string,
  keyframes: Keyframe[],
  defaultValue = 0
): Lane {
  return {
    presetId,
    targetKind,
    targetPresetId,
    paramPath,
    defaultValue,
    keyframes,
  };
}

export interface ClipEvent {
  presetId: string;
  t: number;
  action: string;
  targetKind: 'scene_node' | 'compose_layer';
  targetPresetId: string;
  payload: Record<string, unknown> | null;
}

/** A track-clip event marker: fires a fire-and-forget media command (play /
 *  restart / …) at playhead time `t` on the target entity. See media.md. */
export function clipEvent(
  presetId: string,
  t: number,
  action: string,
  targetKind: 'scene_node' | 'compose_layer',
  targetPresetId: string,
  payload: Record<string, unknown> | null = null
): ClipEvent {
  return { presetId, t, action, targetKind, targetPresetId, payload };
}

export interface TrackClipEntry {
  presetId: string;
  ownerKind: 'scene_node' | 'compose_layer';
  ownerPresetId: string;
  name: string;
  duration: number;
  loop: boolean;
  mode: string;
  autoplay: boolean;
  lanes: Lane[];
  events?: ClipEvent[];
}

export function trackClip(
  presetId: string,
  ownerKind: 'scene_node' | 'compose_layer',
  ownerPresetId: string,
  name: string,
  duration: number,
  mode: 'override' | 'relative',
  loop: boolean,
  autoplay: boolean,
  lanes: Lane[],
  events: ClipEvent[] = []
): TrackClipEntry {
  return {
    presetId,
    ownerKind,
    ownerPresetId,
    name,
    duration,
    loop,
    mode,
    autoplay,
    lanes,
    ...(events.length > 0 ? { events } : {}),
  };
}

// ── Payload assemblers ────────────────────────────────────────────────────

export interface PresetExtras {
  logic?: LogicEntry[];
  trackClips?: TrackClipEntry[];
  animationClips?: unknown[];
}

export function sceneNodePreset(
  id: string,
  name: string,
  description: string,
  sceneNodes: unknown[],
  extra: PresetExtras = {}
): BuiltinPreset {
  return {
    id,
    name,
    description,
    rootKind: 'scene_node',
    payload: {
      format: 'vspark.preset.v2',
      rootKind: 'scene_node',
      assets: [],
      sceneNodes,
      ...(extra.logic ? { logic: extra.logic } : {}),
      ...(extra.trackClips ? { trackClips: extra.trackClips } : {}),
      ...(extra.animationClips ? { animationClips: extra.animationClips } : {}),
    },
  };
}

export function composeLayerPreset(
  id: string,
  name: string,
  description: string,
  composeLayers: unknown[],
  extra: PresetExtras = {}
): BuiltinPreset {
  return {
    id,
    name,
    description,
    rootKind: 'compose_layer',
    payload: {
      format: 'vspark.preset.v2',
      rootKind: 'compose_layer',
      assets: [],
      composeLayers,
      ...(extra.logic ? { logic: extra.logic } : {}),
      ...(extra.trackClips ? { trackClips: extra.trackClips } : {}),
    },
  };
}

// ── Shared feed (chat overlay) template ───────────────────────────────────
// Verbatim copy of FEED_DEFAULT_TEMPLATE / FEED_DEFAULT_CSS from
// packages/frontend/src/lib/feedTemplate.tsx. The feed surfaces (2D layer +
// 3D node) require a non-empty `template` in config — there is no runtime
// fallback to the editor default — so built-ins must ship it inline. The
// `\${` / `\`` escapes reproduce the literal `${` / backtick that htm needs.
export const FEED_CHAT_TEMPLATE = `<div className="chat">
  \${(chat || []).map((m) => html\`
    <div className="msg" key=\${m.id}>
      <span className="name" style=\${{ color: m.color || '#fff' }}>\${m.displayName}</span>: <\${Emote} html=\${m.html} />
    </div>
  \`)}
</div>`;

export const FEED_CHAT_CSS = `.chat { display:flex; flex-direction:column; justify-content:flex-end; height:100%; gap:6px; padding:12px; box-sizing:border-box; overflow:hidden; font-family:system-ui,sans-serif; }
.msg { background:rgba(0,0,0,.55); border-radius:8px; padding:6px 10px; color:#fff; line-height:1.35; animation:pop .25s ease-out; }
.msg .name { font-weight:700; }
.msg img { height:1.3em; vertical-align:-.25em; }
@keyframes pop { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }`;
