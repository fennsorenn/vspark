/**
 * Actions — preauthored, project-level workflows (plan: dev-notes/plans/actions.md).
 *
 * An Action is an interface over a Logic graph: each kind ships a template
 * (`build`), a settings form edits the Action's `settings`, and the graph reads
 * those settings through `settings` nodes at runtime. The graph is stored (a
 * `logic` row owned by the action) and stays fully editable.
 *
 * This module is shared so the backend (create / rebuild / boot regeneration)
 * and the editor (preview, Modified / template-update badges, rebuild-on-shape
 * change) run the SAME template code and the SAME fingerprint — a second copy
 * would drift silently and every graph would read as "modified".
 *
 * Settings come in two classes (decided, see the plan):
 *   - value settings reach the graph through `settings` nodes, live, and never
 *     touch the graph structure;
 *   - shape settings select the template's structure and regenerate the graph.
 * A kind marks its shape fields; every other field is a value. `build` only
 * ever receives the shape projection ({@link shapeOf}), so a template cannot
 * accidentally bake a value setting into the graph.
 */
import {
  toGraphDescriptor,
  type GraphDescriptor,
  type GraphDescriptorDoc,
  type GraphEdgeDescriptor,
  type GraphNodeDescriptor,
} from './signal.js';

/** The shared settings node kind (formerly `behavior_config`). */
export const SETTINGS_NODE_KIND = 'settings';

export type ActionSettings = Record<string, unknown>;

/** `value`: read live through a settings node. `shape`: rebuilds the graph. */
export type SettingClass = 'value' | 'shape';

/** One settings field. `path` is dotted; a `*` segment matches every key of a
 *  keyed map (e.g. `responses.*.type`). */
export interface ActionSettingField {
  path: string;
  class: SettingClass;
}

/** A piece of a row preview. Shared code knows no language and no names, so it
 *  hands the editor i18n keys (`msg`, in the `actions` namespace) and entity
 *  references (`ref`) to resolve, next to literal text. */
export type PreviewToken =
  | { t: 'text'; text: string }
  | { t: 'msg'; key: string; params?: Record<string, string | number> }
  | { t: 'ref'; ref: ResponseRefKind; id: string };

export interface ActionPreview {
  /** The most important setting (a Hotkey's key combo). */
  headline: PreviewToken[];
  /** One line per secondary item (a Hotkey's response per position). */
  lines: PreviewToken[][];
}

/** A graph template's output: the nodes and edges, without the graph's own
 *  id / label (those belong to the stored row). */
export interface TemplateGraph {
  nodes: GraphNodeDescriptor[];
  edges: GraphEdgeDescriptor[];
}

export interface ActionKindDef {
  kind: string;
  /** English label; the editor shows `actions:kinds.<kind>.label`. */
  label: string;
  /** A glyph for the panel's group header. */
  icon: string;
  /** Shape fields, plus value fields for documentation. A path matched by no
   *  shape field is a value. */
  fields: readonly ActionSettingField[];
  /** Fresh default settings. */
  defaults(): ActionSettings;
  /** Coerce stored/incoming settings into a well-formed object (defaults
   *  filled in, enums and ranges enforced). Idempotent. */
  normalize(raw: unknown): ActionSettings;
  /** The template. Receives ONLY the shape projection of the settings. */
  build(shape: ActionSettings): TemplateGraph;
  /** What the panel row shows. */
  preview(settings: ActionSettings): ActionPreview;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A settings node reading one dotted field of the owner's settings. */
function settingsNode(
  id: string,
  field: string,
  x: number,
  y: number
): GraphNodeDescriptor {
  return {
    id,
    kind: SETTINGS_NODE_KIND,
    position: { x, y },
    defaultConfig: { field },
  };
}

function valueEdge(
  fromNodeId: string,
  toNodeId: string,
  toPort: string
): GraphEdgeDescriptor {
  return { fromNodeId, fromPort: 'value', toNodeId, toPort };
}

// ── responses (the Macros panel's response set) ─────────────────────────────

/** Entity kinds a response field can reference (resolved to names by the UI). */
export type ResponseRefKind =
  | 'clip'
  | 'sceneNode'
  | 'composeLayer'
  | 'sceneEntity';

export interface ResponseTypeDef {
  /** The sink node kind. */
  nodeKind: string;
  /** Event-input port the trigger wires into. */
  entryPort: string;
  /** Value fields. Each is a value-input PORT of the sink with the same name,
   *  fed from `responses.<i>.<field>` by a settings node. */
  fields: readonly string[];
}

/** The response set, by id — the same ids, sinks and fields as the Macros
 *  panel's `actionRegistry.ts`, so its field editors can be reused. */
export const RESPONSE_TYPES: Readonly<Record<string, ResponseTypeDef>> = {
  play_clip: { nodeKind: 'start_clip', entryPort: 'fire', fields: ['clipId'] },
  spawn_clip: { nodeKind: 'spawn_clip', entryPort: 'fire', fields: ['clipId'] },
  set_expression: {
    nodeKind: 'set_expression',
    entryPort: 'fire',
    fields: ['nodeId', 'expression', 'weight'],
  },
  set_property: {
    nodeKind: 'set_scene_node_param',
    entryPort: 'fire',
    fields: ['targetId', 'paramPath', 'value'],
  },
  set_layer_property: {
    nodeKind: 'set_compose_layer_param',
    entryPort: 'fire',
    fields: ['targetId', 'paramPath', 'value'],
  },
  control_media: {
    nodeKind: 'media_control',
    entryPort: 'fire',
    fields: ['target', 'action'],
  },
};

export const RESPONSE_TYPE_IDS = Object.keys(RESPONSE_TYPES);

/** Preview tokens for one configured response. */
function responsePreview(resp: Record<string, unknown>): PreviewToken[] {
  const type = typeof resp.type === 'string' ? resp.type : '';
  if (!RESPONSE_TYPES[type]) return [{ t: 'msg', key: 'preview.noResponse' }];
  const out: PreviewToken[] = [{ t: 'msg', key: `responses.${type}` }];
  const str = (k: string) =>
    resp[k] === undefined || resp[k] === null ? '' : String(resp[k]);
  const ref = (kind: ResponseRefKind, k: string) => {
    if (str(k)) out.push({ t: 'ref', ref: kind, id: str(k) });
  };
  switch (type) {
    case 'play_clip':
    case 'spawn_clip':
      ref('clip', 'clipId');
      break;
    case 'set_expression':
      ref('sceneNode', 'nodeId');
      if (str('expression')) out.push({ t: 'text', text: str('expression') });
      break;
    case 'set_property':
    case 'set_layer_property':
      ref(type === 'set_property' ? 'sceneNode' : 'composeLayer', 'targetId');
      if (str('paramPath'))
        out.push({ t: 'text', text: `${str('paramPath')} = ${str('value')}` });
      break;
    case 'control_media':
      ref('sceneEntity', 'target');
      if (str('action'))
        out.push({ t: 'msg', key: `mediaAction.${str('action')}` });
      break;
  }
  return out;
}

// ── Hotkey ───────────────────────────────────────────────────────────────────

export interface HotkeyComboSettings {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export type HotkeyMode = 'single' | 'toggle' | 'cycle';
export const HOTKEY_MODES: readonly HotkeyMode[] = ['single', 'toggle', 'cycle'];
export const MIN_CYCLE_POSITIONS = 2;
export const MAX_CYCLE_POSITIONS = 8;

/** Human-readable shortcut, e.g. "Ctrl + Shift + F8" (same format as the
 *  Macros recorder). Empty string for no key. */
export function formatHotkeyCombo(c: Partial<HotkeyComboSettings>): string {
  const key = typeof c.key === 'string' ? c.key.trim() : '';
  if (!key) return '';
  const parts: string[] = [];
  if (c.ctrl) parts.push('Ctrl');
  if (c.alt) parts.push('Alt');
  if (c.shift) parts.push('Shift');
  if (c.meta) parts.push('Meta');
  parts.push(
    key
      .split(' ')
      .map((w) => (w.length <= 1 ? w : w[0] + w.slice(1).toLowerCase()))
      .join(' ')
  );
  return parts.join(' + ');
}

/** How many response positions a hotkey mode uses. */
export function hotkeyPositionCount(settings: ActionSettings): number {
  const mode = settings.mode as HotkeyMode;
  if (mode === 'toggle') return 2;
  if (mode === 'cycle') return clampPositions(settings.positions);
  return 1;
}

function clampPositions(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return 3;
  return Math.min(MAX_CYCLE_POSITIONS, Math.max(MIN_CYCLE_POSITIONS, n));
}

const COMBO_KEYS = ['key', 'ctrl', 'shift', 'alt', 'meta'] as const;

const hotkey: ActionKindDef = {
  kind: 'hotkey',
  label: 'Hotkey',
  icon: '⌨',
  fields: [
    { path: 'shortcut', class: 'value' },
    { path: 'mode', class: 'shape' },
    { path: 'positions', class: 'shape' },
    { path: 'responses.*.type', class: 'shape' },
    { path: 'responses.*', class: 'value' },
  ],
  defaults: () => ({
    shortcut: { key: '', ctrl: false, shift: false, alt: false, meta: false },
    mode: 'single',
    positions: 3,
    responses: { '0': { type: 'play_clip' } },
  }),
  normalize(raw) {
    const src = isObj(raw) ? raw : {};
    const d = hotkey.defaults();
    const sc = isObj(src.shortcut) ? src.shortcut : {};
    const shortcut: HotkeyComboSettings = {
      key: typeof sc.key === 'string' ? sc.key : '',
      ctrl: sc.ctrl === true,
      shift: sc.shift === true,
      alt: sc.alt === true,
      meta: sc.meta === true,
    };
    const mode = HOTKEY_MODES.includes(src.mode as HotkeyMode)
      ? src.mode
      : d.mode;
    const positions =
      src.positions === undefined ? d.positions : clampPositions(src.positions);
    const responses: Record<string, unknown> = {};
    const srcResp = isObj(src.responses) ? src.responses : d.responses;
    for (const [k, v] of Object.entries(srcResp as Record<string, unknown>)) {
      if (!isObj(v)) continue;
      const r = { ...v };
      if (typeof r.type !== 'string' || !RESPONSE_TYPES[r.type]) delete r.type;
      responses[k] = r;
    }
    return { ...src, shortcut, mode, positions, responses };
  },
  build(shape) {
    const n = hotkeyPositionCount(shape);
    const nodes: GraphNodeDescriptor[] = [];
    const edges: GraphEdgeDescriptor[] = [];
    // The shortcut is a value: read live by the hotkey's combo ports.
    nodes.push({
      id: 'hotkey',
      kind: 'system_hotkey',
      position: { x: 0, y: 140 },
    });
    COMBO_KEYS.forEach((k, j) => {
      const id = `cfg_shortcut_${k}`;
      nodes.push(settingsNode(id, `shortcut.${k}`, -300, j * 70));
      edges.push(valueEdge(id, 'hotkey', k));
    });
    let source = { nodeId: 'hotkey', port: (_i: number) => 'event' };
    if (n > 1) {
      nodes.push({
        id: 'cycle',
        kind: 'cycle',
        position: { x: 260, y: 140 },
        defaultConfig: { count: n },
      });
      edges.push({
        fromNodeId: 'hotkey',
        fromPort: 'event',
        toNodeId: 'cycle',
        toPort: 'in',
      });
      source = { nodeId: 'cycle', port: (i: number) => `out${i}` };
    }
    const responses = isObj(shape.responses) ? shape.responses : {};
    for (let i = 0; i < n; i++) {
      const slot = responses[String(i)];
      const type = isObj(slot) && typeof slot.type === 'string' ? slot.type : '';
      const def = RESPONSE_TYPES[type];
      if (!def) continue; // unset position: that output stays unconnected
      const sinkId = `response_${i}`;
      const y = i * 260;
      nodes.push({ id: sinkId, kind: def.nodeKind, position: { x: 820, y } });
      edges.push({
        fromNodeId: source.nodeId,
        fromPort: source.port(i),
        toNodeId: sinkId,
        toPort: def.entryPort,
      });
      def.fields.forEach((f, j) => {
        const id = `cfg_response_${i}_${f}`;
        nodes.push(settingsNode(id, `responses.${i}.${f}`, 540, y + j * 70));
        edges.push(valueEdge(id, sinkId, f));
      });
    }
    return { nodes, edges };
  },
  preview(settings) {
    const combo = formatHotkeyCombo(
      (isObj(settings.shortcut) ? settings.shortcut : {}) as Partial<
        HotkeyComboSettings
      >
    );
    const headline: PreviewToken[] = [
      combo
        ? { t: 'text', text: combo }
        : { t: 'msg', key: 'preview.noShortcut' },
    ];
    const n = hotkeyPositionCount(settings);
    if (settings.mode === 'toggle')
      headline.push({ t: 'msg', key: 'preview.toggle' });
    if (settings.mode === 'cycle')
      headline.push({ t: 'msg', key: 'preview.cycle', params: { n } });
    const responses = isObj(settings.responses) ? settings.responses : {};
    const lines: PreviewToken[][] = [];
    for (let i = 0; i < n; i++) {
      const slot = responses[String(i)];
      const line = responsePreview(isObj(slot) ? slot : {});
      lines.push(
        n > 1
          ? [{ t: 'msg', key: 'preview.position', params: { n: i + 1 } }, ...line]
          : line
      );
    }
    return { headline, lines };
  },
};

// ── registry ─────────────────────────────────────────────────────────────────

export const ACTION_KINDS: readonly ActionKindDef[] = [hotkey];

const BY_KIND = new Map(ACTION_KINDS.map((k) => [k.kind, k]));

export function actionKind(kind: string): ActionKindDef | undefined {
  return BY_KIND.get(kind);
}

/** Is `path` (concrete, dotted) a shape setting of `kind`? */
export function settingClassOf(kind: string, path: string): SettingClass {
  const def = actionKind(kind);
  if (!def) return 'value';
  const segs = path.split('.');
  for (const f of def.fields) {
    if (f.class !== 'shape') continue;
    const pat = f.path.split('.');
    if (pat.length !== segs.length) continue;
    if (pat.every((p, i) => p === '*' || p === segs[i])) return 'shape';
  }
  return 'value';
}

/** Copy the parts of `src` addressed by `pat` (dotted, `*` = every key). */
function pick(
  src: unknown,
  pat: string[],
  out: Record<string, unknown>
): void {
  if (!isObj(src) || pat.length === 0) return;
  const [head, ...rest] = pat;
  const keys = head === '*' ? Object.keys(src) : [head];
  for (const k of keys) {
    if (!(k in src)) continue;
    const v = src[k];
    if (rest.length === 0) {
      out[k] = v;
    } else if (isObj(v)) {
      const child = (isObj(out[k]) ? out[k] : (out[k] = {})) as Record<
        string,
        unknown
      >;
      pick(v, rest, child);
    }
  }
}

/** The shape projection of `settings`: only the fields `kind` marks as shape,
 *  after normalization. What `build` receives. */
export function shapeOf(kind: string, settings: unknown): ActionSettings {
  const def = actionKind(kind);
  if (!def) return {};
  const norm = def.normalize(settings);
  const out: ActionSettings = {};
  for (const f of def.fields)
    if (f.class === 'shape') pick(norm, f.path.split('.'), out);
  return out;
}

/** Normalize settings for `kind` (unknown kinds pass through as an object). */
export function normalizeSettings(
  kind: string,
  settings: unknown
): ActionSettings {
  const def = actionKind(kind);
  if (def) return def.normalize(settings);
  return isObj(settings) ? { ...settings } : {};
}

/** The graph id an action's graph is created under. Derived, not minted, so
 *  two writers that both build an action's graph (a tab and the server's boot
 *  repair, say) converge on one document instead of creating two. */
export function actionGraphId(actionId: string): string {
  return `${actionId}-graph`;
}

/** The template output for `kind` + `settings` as a runtime descriptor. */
export function buildActionGraph(
  kind: string,
  settings: unknown,
  graphId: string,
  label: string
): GraphDescriptor {
  const def = actionKind(kind);
  const g = def ? def.build(shapeOf(kind, settings)) : { nodes: [], edges: [] };
  return { id: graphId, label, readonly: false, nodes: g.nodes, edges: g.edges };
}

// ── fingerprint ──────────────────────────────────────────────────────────────

function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

/** cyrb53 — a small, fast, well-distributed 53-bit string hash. Not
 *  cryptographic; it only has to tell graph structures apart. */
function hash53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}

/**
 * Fingerprint of a graph's STRUCTURE: node ids, kinds and defaultConfig, and
 * the edges. Node positions, the graph's own id / label / readonly, and edge
 * transport hints are left out — tidying the canvas is not a modification.
 * Accepts the runtime (list) or document (keyed) form.
 */
export function graphFingerprint(
  d: GraphDescriptor | GraphDescriptorDoc | null | undefined
): string {
  const g = toGraphDescriptor(d);
  const nodes = g.nodes
    .map((n) => ({ id: n.id, kind: n.kind, config: n.defaultConfig ?? {} }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const edges = g.edges
    .map((e) => `${e.fromNodeId}:${e.fromPort}>${e.toNodeId}:${e.toPort}`)
    .sort();
  return hash53(canonical({ nodes, edges }));
}

/** Fingerprint of what the template produces for these settings. */
export function templateFingerprint(kind: string, settings: unknown): string {
  return graphFingerprint(buildActionGraph(kind, settings, '', ''));
}

/** Would changing `prev` to `next` change the generated graph (a shape
 *  change)? Value-only edits answer false. */
export function changesShape(
  kind: string,
  prev: unknown,
  next: unknown
): boolean {
  return templateFingerprint(kind, prev) !== templateFingerprint(kind, next);
}

export interface ActionGraphStatus {
  /** No graph exists for the action (Reset creates it). */
  missingGraph: boolean;
  /** The graph differs from the template output it was generated from. */
  modified: boolean;
  /** The template now produces something else than what the graph was
   *  generated from (template code changed, or a shape edit was kept off a
   *  modified graph). */
  templateUpdateAvailable: boolean;
}

/** Derived state for the panel badges and the REST read model. */
export function actionGraphStatus(
  action: { kind: string; settings: unknown; templateFingerprint?: string | null },
  graphDescriptor: GraphDescriptor | GraphDescriptorDoc | null | undefined
): ActionGraphStatus {
  const generated = action.templateFingerprint ?? null;
  const target = templateFingerprint(action.kind, action.settings);
  if (!graphDescriptor)
    return {
      missingGraph: true,
      modified: false,
      templateUpdateAvailable: generated !== target,
    };
  return {
    missingGraph: false,
    modified: graphFingerprint(graphDescriptor) !== generated,
    templateUpdateAvailable: generated !== target,
  };
}
