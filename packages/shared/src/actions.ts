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

/**
 * Add one response sink (by the slot's `type`) fired from `from`, its value
 * fields fed by settings nodes reading `<fieldPrefix><field>`. Nothing is
 * added when the slot has no known type. Returns whether a sink was added.
 */
function addResponse(
  nodes: GraphNodeDescriptor[],
  edges: GraphEdgeDescriptor[],
  o: {
    slot: unknown;
    sinkId: string;
    cfgPrefix: string;
    fieldPrefix: string;
    from: { nodeId: string; port: string };
    x: number;
    y: number;
  }
): boolean {
  const type =
    isObj(o.slot) && typeof o.slot.type === 'string' ? o.slot.type : '';
  const def = RESPONSE_TYPES[type];
  if (!def) return false;
  nodes.push({ id: o.sinkId, kind: def.nodeKind, position: { x: o.x, y: o.y } });
  edges.push({
    fromNodeId: o.from.nodeId,
    fromPort: o.from.port,
    toNodeId: o.sinkId,
    toPort: def.entryPort,
  });
  def.fields.forEach((f, j) => {
    const id = `${o.cfgPrefix}${f}`;
    nodes.push(settingsNode(id, `${o.fieldPrefix}${f}`, o.x - 280, o.y + j * 70));
    edges.push(valueEdge(id, o.sinkId, f));
  });
  return true;
}

/** A response slot with a known `type` kept, an unknown one dropped. */
function normalizeResponse(v: unknown): Record<string, unknown> {
  if (!isObj(v)) return {};
  const r = { ...v };
  if (typeof r.type !== 'string' || !RESPONSE_TYPES[r.type]) delete r.type;
  return r;
}

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
      // An unset position leaves that output unconnected.
      addResponse(nodes, edges, {
        slot: responses[String(i)],
        sinkId: `response_${i}`,
        cfgPrefix: `cfg_response_${i}_`,
        fieldPrefix: `responses.${i}.`,
        from: { nodeId: source.nodeId, port: source.port(i) },
        x: 820,
        y: i * 260,
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

// ── chat / redemption building blocks ───────────────────────────────────────
//
// The chat and redemption kinds share their settings shapes (account, minimum
// rank, cooldown, counter, reply) and the template pieces that read them. Every
// optional part (args pattern, counter, reply, trigger, marking a redemption
// complete) sits in a FIXED structure, switched by a value setting through an
// `if_else` (or by being empty — an empty reply sends nothing, an empty trigger
// name sends no trigger), so typing never rebuilds the graph. Only a response
// TYPE is a shape setting.
//
// Some values the graph needs are functions of what the form edits — a regex
// built from a command and its aliases, a counter's scope that depends on
// whether it is named. `normalize` computes them into `settings.derived`, where
// `settings` nodes read them like any other value. They are recomputed on
// every normalized write (the backend normalizes every action write), never
// edited by the form.

/** Chat ranks, lowest first (the `chat_rank` node's ranks). */
export const CHAT_RANKS = ['everyone', 'sub', 'mod', 'broadcaster'] as const;
export type ChatRank = (typeof CHAT_RANKS)[number];

const strOf = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const boolOf = (v: unknown, d: boolean): boolean =>
  typeof v === 'boolean' ? v : d;
function numOf(v: unknown, d: number, min = -Infinity, max = Infinity): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
}

/** Escape text for literal use inside a regular expression (also valid
 *  with the `u` flag: only syntax characters are escaped). */
export function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** A command and its aliases as bare names: prefix `!` stripped, empty and
 *  duplicate (case-insensitive) names dropped. Aliases are separated by
 *  spaces or commas — a command name cannot contain a space. */
export function commandNames(command: unknown, aliases: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const all = [strOf(command), ...strOf(aliases).split(/[\s,]+/)];
  for (const raw of all) {
    const name = raw.trim().replace(/^!+/, '').trim();
    if (!name || /\s/.test(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** Keywords / emote names from a comma- or newline-separated list. A keyword
 *  may be a phrase (spaces are kept). */
export function keywordList(keywords: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of strOf(keywords).split(/[,\n]/)) {
    const k = raw.trim().replace(/\s+/g, ' ');
    if (!k || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
  }
  return out;
}

/** Regex (flags `i`) matching exactly one of the command names, or '' (which
 *  the regex node treats as "never matches") when there are none. */
export function commandPattern(names: string[]): string {
  return names.length
    ? `^(?:${names.map(escapeRegExp).join('|')})$`
    : '';
}

/** Regex (flags `iu`) finding any keyword as a whole word: not preceded or
 *  followed by a letter, digit or underscore, so emotes such as `:)` work
 *  too. '' when there are none. */
export function keywordPattern(words: string[]): string {
  if (!words.length) return '';
  const alts = words
    .map((w) => w.split(' ').map(escapeRegExp).join('\\s+'))
    .join('|');
  return `(?<![\\p{L}\\p{N}_])(?:${alts})(?![\\p{L}\\p{N}_])`;
}

/** The regex flags the keyword templates use with {@link keywordPattern}. */
export const KEYWORD_FLAGS = 'iu';

/** A user's pattern anchored to the whole text ('' stays ''). */
export function fullTextPattern(pattern: unknown): string {
  const p = strOf(pattern);
  return p ? `^(?:${p})$` : '';
}

export interface CooldownSettings {
  seconds: number;
  group: string;
}
function normalizeCooldown(v: unknown, seconds: number): CooldownSettings {
  const c = isObj(v) ? v : {};
  return {
    seconds: numOf(c.seconds, seconds, 0),
    group: strOf(c.group).trim(),
  };
}

export interface CounterSettings {
  enabled: boolean;
  /** Empty: the action's own counter (scope = its graph id, name `count`).
   *  Named: a shared variable (scope ''), readable by any graph. */
  name: string;
  step: number;
  persistent: boolean;
}
function normalizeCounter(v: unknown): CounterSettings {
  const c = isObj(v) ? v : {};
  return {
    enabled: boolOf(c.enabled, false),
    name: strOf(c.name).trim(),
    step: numOf(c.step, 1),
    persistent: boolOf(c.persistent, true),
  };
}
/** The counter's variable name and scope template (see the builder). */
function counterDerived(c: CounterSettings) {
  return {
    counterName: c.name || 'count',
    // Rendered by a `text_format` whose `id` field is the graph's id
    // (`logic_id`): an unnamed counter is graph-local, a named one shared.
    counterScope: c.name ? '' : '${id}',
  };
}

const rankOf = (v: unknown): ChatRank =>
  CHAT_RANKS.includes(v as ChatRank) ? (v as ChatRank) : 'everyone';

/** Builder for the chat / redemption templates: one settings node per field,
 *  shared by every port that reads it (ids `cfg_<field with _ for .>`). */
class Tpl {
  readonly nodes: GraphNodeDescriptor[] = [];
  readonly edges: GraphEdgeDescriptor[] = [];
  private readonly cfg = new Map<string, string>();

  node(
    id: string,
    kind: string,
    x: number,
    y: number,
    defaultConfig?: Record<string, unknown>
  ): string {
    this.nodes.push(
      defaultConfig
        ? { id, kind, position: { x, y }, defaultConfig }
        : { id, kind, position: { x, y } }
    );
    return id;
  }

  wire(fromNodeId: string, fromPort: string, toNodeId: string, toPort: string) {
    this.edges.push({ fromNodeId, fromPort, toNodeId, toPort });
  }

  /** Feed settings field `field` into `to.toPort`. The settings node is
   *  created at (`x`, `y`) on first use. */
  setting(field: string, to: string, toPort: string, x: number, y: number) {
    let id = this.cfg.get(field);
    if (!id) {
      id = `cfg_${field.replace(/\./g, '_')}`;
      this.cfg.set(field, id);
      this.nodes.push(settingsNode(id, field, x, y));
    }
    this.edges.push(valueEdge(id, to, toPort));
  }

  out(): TemplateGraph {
    return { nodes: this.nodes, edges: this.edges };
  }
}

type Out = [nodeId: string, port: string];

/** Chat trigger → `chat_rank` gate (isSub / isMod / isBroadcaster of the
 *  trigger, `minRank` setting). */
function addRankGate(b: Tpl, source: string, entry: Out, x: number): Out {
  b.node('rank', 'chat_rank', x, 420);
  for (const p of ['isSub', 'isMod', 'isBroadcaster']) b.wire(source, p, 'rank', p);
  b.setting('minRank', 'rank', 'minRank', x - 280, 560);
  b.node('rank_gate', 'if_else', x + 280, 200);
  b.wire(entry[0], entry[1], 'rank_gate', 'in');
  b.wire('rank', 'allowed', 'rank_gate', 'condition');
  return ['rank_gate', 'then'];
}

/** `cooldown` fed by every entry (seconds + optional shared group). */
function addCooldown(b: Tpl, entries: Out[], x: number): Out {
  b.node('cooldown', 'cooldown', x, 200);
  for (const [n, p] of entries) b.wire(n, p, 'cooldown', 'in');
  b.setting('cooldown.seconds', 'cooldown', 'seconds', x - 280, 640);
  b.setting('cooldown.group', 'cooldown', 'group', x - 280, 710);
  return ['cooldown', 'out'];
}

/**
 * Optional counter + chat reply, from `entry`:
 *
 *   entry ─▶ if_else(counter.enabled) ─then▶ increment_variable ─done▶ send
 *                                     └else────────────────────────────▶ send
 *   text_format(reply; fields…, count ← variable, values ← `values`) ─▶ send.template
 *
 * The counter's variable is `derived.counterName` in the scope rendered from
 * `derived.counterScope` (graph-local or shared). An empty reply sends nothing.
 */
function addCounterReply(
  b: Tpl,
  entry: Out,
  fields: Record<string, Out>,
  values: Out | null,
  x: number
): void {
  b.node('counter_gate', 'if_else', x, 200);
  b.wire(entry[0], entry[1], 'counter_gate', 'in');
  b.setting('counter.enabled', 'counter_gate', 'condition', x - 280, 780);
  b.node('this_logic', 'logic_id', x, 860);
  b.node('counter_scope', 'text_format', x + 280, 860, { fields: ['id'] });
  b.wire('this_logic', 'id', 'counter_scope', 'id');
  b.setting('derived.counterScope', 'counter_scope', 'template', x, 960);
  b.node('counter', 'increment_variable', x + 560, 420);
  b.wire('counter_gate', 'then', 'counter', 'fire');
  b.setting('derived.counterName', 'counter', 'name', x + 280, 560);
  b.wire('counter_scope', 'text', 'counter', 'scope');
  b.setting('counter.step', 'counter', 'by', x + 280, 640);
  b.setting('counter.persistent', 'counter', 'persistent', x + 280, 710);
  b.node('count', 'variable', x + 560, 760);
  b.setting('derived.counterName', 'count', 'name', 0, 0);
  b.wire('counter_scope', 'text', 'count', 'scope');
  b.node('reply', 'text_format', x + 840, 560, {
    fields: [...Object.keys(fields), 'count'],
  });
  b.setting('reply', 'reply', 'template', x + 560, 940);
  for (const [field, [n, p]] of Object.entries(fields)) b.wire(n, p, 'reply', field);
  b.wire('count', 'value', 'reply', 'count');
  if (values) b.wire(values[0], values[1], 'reply', 'values');
  b.node('send', 'overlive_send_chat', x + 1120, 200);
  b.wire('counter', 'done', 'send', 'fire');
  b.wire('counter_gate', 'else', 'send', 'fire');
  b.wire('reply', 'text', 'send', 'template');
  b.setting('account', 'send', 'account', 0, 0);
}

/** Preview tokens for rank / cooldown / counter, where they are set. */
function chatMeta(s: ActionSettings): PreviewToken[] {
  const out: PreviewToken[] = [];
  const rank = rankOf(s.minRank);
  if (rank !== 'everyone') out.push({ t: 'msg', key: `preview.rank.${rank}` });
  const cd = normalizeCooldown(s.cooldown, 0);
  if (cd.seconds > 0)
    out.push(
      cd.group
        ? { t: 'msg', key: 'preview.cooldownGroup', params: { s: cd.seconds, group: cd.group } }
        : { t: 'msg', key: 'preview.cooldown', params: { s: cd.seconds } }
    );
  out.push(...counterMeta(s));
  return out;
}

function counterMeta(s: ActionSettings): PreviewToken[] {
  const c = normalizeCounter(s.counter);
  if (!c.enabled) return [];
  return [
    c.name
      ? { t: 'msg', key: 'preview.counter', params: { name: c.name } }
      : { t: 'msg', key: 'preview.counterOwn' },
  ];
}

/** The reply as a quoted line, or "no reply". */
function replyLine(reply: unknown): PreviewToken[] {
  const r = strOf(reply).trim();
  return r
    ? [{ t: 'text', text: `“${r}”` }]
    : [{ t: 'msg', key: 'preview.noReply' }];
}

function triggerLine(s: ActionSettings): PreviewToken[][] {
  const name = strOf(s.trigger).trim();
  return name ? [[{ t: 'msg', key: 'preview.trigger', params: { name } }]] : [];
}

/** Fields every chat-reply kind shares, normalized. */
function chatBase(src: Record<string, unknown>, cooldownSeconds: number) {
  const counter = normalizeCounter(src.counter);
  return {
    account: strOf(src.account),
    minRank: rankOf(src.minRank),
    cooldown: normalizeCooldown(src.cooldown, cooldownSeconds),
    reply: strOf(src.reply),
    counter,
  };
}

const VALUE_FIELDS_CHAT: ActionSettingField[] = [
  { path: 'account', class: 'value' },
  { path: 'minRank', class: 'value' },
  { path: 'cooldown', class: 'value' },
  { path: 'reply', class: 'value' },
  { path: 'counter', class: 'value' },
  { path: 'derived', class: 'value' },
];

const DEFAULT_CHAT_COOLDOWN = 10;

// ── Chat command ─────────────────────────────────────────────────────────────

const chatCommand: ActionKindDef = {
  kind: 'chat_command',
  label: 'Chat command',
  icon: '❗',
  // No shape field: every optional part is gated in a fixed structure.
  fields: [
    { path: 'command', class: 'value' },
    { path: 'aliases', class: 'value' },
    { path: 'argsPattern', class: 'value' },
    ...VALUE_FIELDS_CHAT,
  ],
  defaults: () => chatCommand.normalize({}),
  normalize(raw) {
    const src = isObj(raw) ? raw : {};
    const base = chatBase(src, DEFAULT_CHAT_COOLDOWN);
    const command = strOf(src.command).trim();
    const aliases = strOf(src.aliases);
    return {
      ...src,
      ...base,
      command,
      aliases,
      argsPattern: strOf(src.argsPattern),
      derived: {
        commandPattern: commandPattern(commandNames(command, aliases)),
        ...counterDerived(base.counter),
      },
    };
  },
  build() {
    const b = new Tpl();
    b.node('trigger', 'overlive_chat_command', 0, 200);
    b.setting('account', 'trigger', 'account', -280, 200);
    b.node('command_match', 'regex', 280, 420, { flags: 'i' });
    b.wire('trigger', 'command', 'command_match', 'text');
    b.setting('derived.commandPattern', 'command_match', 'pattern', 0, 500);
    b.node('command_gate', 'if_else', 560, 200);
    b.wire('trigger', 'event', 'command_gate', 'in');
    b.wire('command_match', 'matched', 'command_gate', 'condition');
    const ranked = addRankGate(b, 'trigger', ['command_gate', 'then'], 840);
    // Optional args pattern: an empty pattern skips the check.
    b.node('args_match', 'regex', 1120, 420, { flags: 'i' });
    b.wire('trigger', 'args', 'args_match', 'text');
    b.setting('argsPattern', 'args_match', 'pattern', 840, 640);
    b.node('args_optional', 'equals', 1120, 600, { b: '' });
    b.setting('argsPattern', 'args_optional', 'a', 0, 0);
    b.node('args_skip', 'if_else', 1400, 200);
    b.wire(ranked[0], ranked[1], 'args_skip', 'in');
    b.wire('args_optional', 'equal', 'args_skip', 'condition');
    b.node('args_gate', 'if_else', 1680, 320);
    b.wire('args_skip', 'else', 'args_gate', 'in');
    b.wire('args_match', 'matched', 'args_gate', 'condition');
    const passed = addCooldown(
      b,
      [
        ['args_skip', 'then'],
        ['args_gate', 'then'],
      ],
      1960
    );
    addCounterReply(
      b,
      passed,
      { user: ['trigger', 'displayName'], args: ['trigger', 'args'] },
      ['args_match', 'groups'],
      2240
    );
    return b.out();
  },
  preview(s) {
    const names = commandNames(s.command, s.aliases);
    const headline: PreviewToken[] = names.length
      ? names.map((n) => ({ t: 'text' as const, text: `!${n}` }))
      : [{ t: 'msg', key: 'preview.noCommand' }];
    headline.push(...chatMeta(s));
    const lines = [replyLine(s.reply)];
    const args = strOf(s.argsPattern);
    if (args)
      lines.push([
        { t: 'msg', key: 'preview.argsPattern' },
        { t: 'text', text: `/${args}/` },
      ]);
    return { headline, lines };
  },
};

// ── Chat pattern ─────────────────────────────────────────────────────────────

const chatPattern: ActionKindDef = {
  kind: 'chat_pattern',
  label: 'Chat pattern',
  icon: '✱',
  fields: [{ path: 'pattern', class: 'value' }, ...VALUE_FIELDS_CHAT],
  defaults: () => chatPattern.normalize({}),
  normalize(raw) {
    const src = isObj(raw) ? raw : {};
    const base = chatBase(src, DEFAULT_CHAT_COOLDOWN);
    const pattern = strOf(src.pattern);
    return {
      ...src,
      ...base,
      pattern,
      derived: {
        fullPattern: fullTextPattern(pattern),
        ...counterDerived(base.counter),
      },
    };
  },
  build() {
    const b = new Tpl();
    b.node('trigger', 'overlive_chat_message', 0, 200);
    b.setting('account', 'trigger', 'account', -280, 200);
    b.node('pattern_match', 'regex', 280, 420, { flags: 'i' });
    b.wire('trigger', 'text', 'pattern_match', 'text');
    b.setting('derived.fullPattern', 'pattern_match', 'pattern', 0, 500);
    b.node('pattern_gate', 'if_else', 560, 200);
    b.wire('trigger', 'event', 'pattern_gate', 'in');
    b.wire('pattern_match', 'matched', 'pattern_gate', 'condition');
    const ranked = addRankGate(b, 'trigger', ['pattern_gate', 'then'], 840);
    const passed = addCooldown(b, [ranked], 1400);
    addCounterReply(
      b,
      passed,
      { user: ['trigger', 'displayName'], message: ['trigger', 'text'] },
      ['pattern_match', 'groups'],
      1680
    );
    return b.out();
  },
  preview(s) {
    const p = strOf(s.pattern);
    const headline: PreviewToken[] = [
      p ? { t: 'text', text: `/${p}/` } : { t: 'msg', key: 'preview.noPattern' },
      ...chatMeta(s),
    ];
    return { headline, lines: [replyLine(s.reply)] };
  },
};

// ── responses for the single-response kinds ─────────────────────────────────

const RESPONSE_FIELDS: ActionSettingField[] = [
  { path: 'response.type', class: 'shape' },
  { path: 'response', class: 'value' },
];

/** The kind's one response sink, fired from `from` (`response.<field>`). */
function addSingleResponse(
  b: Tpl,
  shape: ActionSettings,
  from: Out,
  x: number,
  y: number
): void {
  addResponse(b.nodes, b.edges, {
    slot: shape.response,
    sinkId: 'response',
    cfgPrefix: 'cfg_response_',
    fieldPrefix: 'response.',
    from: { nodeId: from[0], port: from[1] },
    x,
    y,
  });
}

/** Default response of the single-response kinds: none chosen yet. */
const NO_RESPONSE = (): Record<string, unknown> => ({});

const keywordsHeadline = (s: ActionSettings): PreviewToken[] => {
  const words = keywordList(s.keywords);
  return words.length
    ? [{ t: 'text', text: words.join(', ') }]
    : [{ t: 'msg', key: 'preview.noKeywords' }];
};

const responseLine = (s: ActionSettings): PreviewToken[] =>
  responsePreview(isObj(s.response) ? s.response : {});

// ── Chat keyword ─────────────────────────────────────────────────────────────

const chatKeyword: ActionKindDef = {
  kind: 'chat_keyword',
  label: 'Chat keyword',
  icon: '💬',
  fields: [
    { path: 'account', class: 'value' },
    { path: 'keywords', class: 'value' },
    { path: 'cooldown', class: 'value' },
    { path: 'trigger', class: 'value' },
    { path: 'derived', class: 'value' },
    ...RESPONSE_FIELDS,
  ],
  defaults: () => chatKeyword.normalize({ response: { type: 'play_clip' } }),
  normalize(raw) {
    const src = isObj(raw) ? raw : {};
    const keywords = strOf(src.keywords);
    return {
      ...src,
      account: strOf(src.account),
      keywords,
      cooldown: normalizeCooldown(src.cooldown, DEFAULT_CHAT_COOLDOWN),
      response: normalizeResponse(src.response ?? NO_RESPONSE()),
      trigger: strOf(src.trigger).trim(),
      derived: { keywordPattern: keywordPattern(keywordList(keywords)) },
    };
  },
  build(shape) {
    const b = new Tpl();
    b.node('trigger', 'overlive_chat_message', 0, 200);
    b.setting('account', 'trigger', 'account', -280, 200);
    b.node('keyword_match', 'regex', 280, 420, { flags: KEYWORD_FLAGS });
    b.wire('trigger', 'text', 'keyword_match', 'text');
    b.setting('derived.keywordPattern', 'keyword_match', 'pattern', 0, 500);
    b.node('keyword_gate', 'if_else', 560, 200);
    b.wire('trigger', 'event', 'keyword_gate', 'in');
    b.wire('keyword_match', 'matched', 'keyword_gate', 'condition');
    const passed = addCooldown(b, [['keyword_gate', 'then']], 840);
    addSingleResponse(b, shape, passed, 1400, 0);
    // Optional trigger: an empty name sends nothing.
    b.node('emit', 'send_trigger', 1400, 560);
    b.wire(passed[0], passed[1], 'emit', 'fire');
    b.setting('trigger', 'emit', 'name', 1120, 640);
    b.wire('trigger', 'data', 'emit', 'payload');
    return b.out();
  },
  preview(s) {
    const headline = keywordsHeadline(s);
    const cd = normalizeCooldown(s.cooldown, 0);
    if (cd.seconds > 0)
      headline.push(
        cd.group
          ? { t: 'msg', key: 'preview.cooldownGroup', params: { s: cd.seconds, group: cd.group } }
          : { t: 'msg', key: 'preview.cooldown', params: { s: cd.seconds } }
      );
    return { headline, lines: [responseLine(s), ...triggerLine(s)] };
  },
};

// ── Keyword combo ────────────────────────────────────────────────────────────

const keywordCombo: ActionKindDef = {
  kind: 'keyword_combo',
  label: 'Keyword combo',
  icon: '🔥',
  fields: [
    { path: 'account', class: 'value' },
    { path: 'keywords', class: 'value' },
    { path: 'threshold', class: 'value' },
    { path: 'window', class: 'value' },
    { path: 'uniqueChatters', class: 'value' },
    { path: 'endMessage', class: 'value' },
    { path: 'derived', class: 'value' },
    ...RESPONSE_FIELDS,
  ],
  defaults: () => keywordCombo.normalize({ response: { type: 'play_clip' } }),
  normalize(raw) {
    const src = isObj(raw) ? raw : {};
    const keywords = strOf(src.keywords);
    const uniqueChatters = boolOf(src.uniqueChatters, true);
    return {
      ...src,
      account: strOf(src.account),
      keywords,
      threshold: Math.round(numOf(src.threshold, 5, 1)),
      window: numOf(src.window, 10, 0),
      uniqueChatters,
      response: normalizeResponse(src.response ?? NO_RESPONSE()),
      endMessage: strOf(src.endMessage),
      derived: {
        keywordPattern: keywordPattern(keywordList(keywords)),
        // Rendered by a `text_format` whose `user` field is the chatter: the
        // combo key is the username (unique chatters) or '' (every message).
        comboKey: uniqueChatters ? '${user}' : '',
      },
    };
  },
  build(shape) {
    const b = new Tpl();
    b.node('trigger', 'overlive_chat_message', 0, 200);
    b.setting('account', 'trigger', 'account', -280, 200);
    b.node('keyword_match', 'regex', 280, 420, { flags: KEYWORD_FLAGS });
    b.wire('trigger', 'text', 'keyword_match', 'text');
    b.setting('derived.keywordPattern', 'keyword_match', 'pattern', 0, 500);
    b.node('keyword_gate', 'if_else', 560, 200);
    b.wire('trigger', 'event', 'keyword_gate', 'in');
    b.wire('keyword_match', 'matched', 'keyword_gate', 'condition');
    b.node('combo_key', 'text_format', 560, 600, { fields: ['user'] });
    b.wire('trigger', 'username', 'combo_key', 'user');
    b.setting('derived.comboKey', 'combo_key', 'template', 280, 680);
    // Both combo nodes count the same hits with the same key and timing.
    b.node('threshold', 'combo_threshold', 840, 0);
    b.wire('keyword_gate', 'then', 'threshold', 'in');
    b.setting('threshold', 'threshold', 'threshold', 560, -100);
    b.setting('window', 'threshold', 'window', 560, -30);
    b.wire('combo_key', 'text', 'threshold', 'key');
    b.node('timeout', 'combo_timeout', 840, 400);
    b.wire('keyword_gate', 'then', 'timeout', 'in');
    b.setting('window', 'timeout', 'timeout', 0, 0);
    b.wire('combo_key', 'text', 'timeout', 'key');
    addSingleResponse(b, shape, ['threshold', 'reached'], 1400, -200);
    // "Reached" is remembered in a graph-local short-lived variable so the end
    // message goes out only for combos that reached the threshold (the
    // timeout node ends every combo, however small).
    b.node('this_logic', 'logic_id', 840, 760);
    b.node('reached_set', 'set_variable', 1120, 200, {
      name: 'comboReached',
      value: true,
      persistent: false,
    });
    b.wire('threshold', 'reached', 'reached_set', 'fire');
    b.wire('this_logic', 'id', 'reached_set', 'scope');
    b.node('reached', 'variable', 1120, 700, { name: 'comboReached' });
    b.wire('this_logic', 'id', 'reached', 'scope');
    b.node('end_gate', 'if_else', 1400, 400);
    b.wire('timeout', 'ended', 'end_gate', 'in');
    b.wire('reached', 'value', 'end_gate', 'condition');
    b.node('reached_clear', 'set_variable', 1680, 560, {
      name: 'comboReached',
      value: false,
      persistent: false,
    });
    b.wire('end_gate', 'then', 'reached_clear', 'fire');
    b.wire('this_logic', 'id', 'reached_clear', 'scope');
    b.node('end_text', 'text_format', 1400, 760, { fields: ['count'] });
    b.wire('timeout', 'count', 'end_text', 'count');
    b.setting('endMessage', 'end_text', 'template', 1120, 860);
    // An empty end message sends nothing.
    b.node('end_send', 'overlive_send_chat', 1680, 400);
    b.wire('end_gate', 'then', 'end_send', 'fire');
    b.wire('end_text', 'text', 'end_send', 'template');
    b.setting('account', 'end_send', 'account', 0, 0);
    return b.out();
  },
  preview(s) {
    const headline = keywordsHeadline(s);
    headline.push({
      t: 'msg',
      key: 'preview.combo',
      params: { n: numOf(s.threshold, 5), s: numOf(s.window, 10) },
    });
    if (s.uniqueChatters !== false) headline.push({ t: 'msg', key: 'preview.unique' });
    const lines = [responseLine(s)];
    const end = strOf(s.endMessage).trim();
    if (end)
      lines.push([
        { t: 'msg', key: 'preview.endMessage' },
        { t: 'text', text: `“${end}”` },
      ]);
    return { headline, lines };
  },
};

// ── registry ─────────────────────────────────────────────────────────────────

export const ACTION_KINDS: readonly ActionKindDef[] = [
  hotkey,
  chatCommand,
  chatPattern,
  chatKeyword,
  keywordCombo,
];

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
