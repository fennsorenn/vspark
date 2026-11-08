/**
 * Composites — built-in templates packaged as one object with its own
 * settings (see dev-notes/plans/composites.md).
 *
 * A composite is an ordinary parent (a compose layer or a scene node) whose
 * root carries a marker: its type and which entity plays which part
 * (`parts: role → id`). The parts are its children, its owned logic graph and
 * its owned track clips.
 *
 * Settings are a *live link* (decided, user 2026-11-08): a setting has no
 * stored value of its own. It points at fields of the parts and writes straight
 * into them, so the parts stay the single source of truth and nothing is ever
 * regenerated. A setting is either a list of links (a document field, or a CSS
 * custom property inside a CSS string field), or code-defined `get` / `set`
 * for settings that touch several things at once (the alert's trigger, its
 * display time, its badge type).
 *
 * This module is pure: it reads documents through a lookup the caller
 * supplies and returns the field writes to make. The editor issues them in one
 * mesh batch (one undo step); the backend uses the protection helpers.
 */
import { edgeKey, toGraphDescriptor } from './signal.js';
import type { GraphEdgeDescriptor, GraphNodeDescriptor } from './signal.js';
import { itemsOf, type IdMap } from './idMap.js';

/** Entities that can be a composite's root. */
export type CompositeRootRtype = 'compose_layer' | 'scene_node';
/** Documents a part can be. */
export type PartRtype = CompositeRootRtype | 'logic' | 'track_clip';

type Doc = Record<string, unknown>;

export interface CompositeMarker {
  type: string;
  /** role → id of the entity playing it. */
  parts: Record<string, string>;
}

/** Where the marker lives on a root: a layer's free-form `config`, a node's
 *  free-form `properties` (not `components`, whose entries are typed ECS
 *  components). */
export const MARKER_PATH: Record<CompositeRootRtype, string> = {
  compose_layer: 'config.composite',
  scene_node: 'properties.composite',
};

const isObj = (v: unknown): v is Doc =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Read a dotted path out of a document. */
export function getPath(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const key of path.split('.')) {
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** The composite marker on a root document, or null when it isn't one. */
export function compositeMarkerOf(
  rtype: string,
  doc: unknown
): CompositeMarker | null {
  if (rtype !== 'compose_layer' && rtype !== 'scene_node') return null;
  const m = getPath(doc, MARKER_PATH[rtype]);
  if (!isObj(m) || typeof m.type !== 'string' || !isObj(m.parts)) return null;
  const parts: Record<string, string> = {};
  for (const [role, id] of Object.entries(m.parts))
    if (typeof id === 'string' && id !== '') parts[role] = id;
  return { type: m.type, parts };
}

// ── Part protection ─────────────────────────────────────────────────────────
//
// Decided (user, 2026-11-08): a part's container and depth must not change and
// a part can't be deleted, because the composite's logic may address it.
// Reordering among siblings is allowed. Dissolving lifts it.

/** The composite root that lists `id` as one of its parts, searching up from
 *  the entity's parent. `parentOf` answers the parent id of an entity of the
 *  same rtype; `markerOf` the marker on one (null when not a composite). */
export function owningComposite(
  id: string,
  parentId: string | null | undefined,
  parentOf: (id: string) => string | null | undefined,
  markerOf: (id: string) => CompositeMarker | null
): string | null {
  const seen = new Set<string>();
  let cur = parentId ?? null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const m = markerOf(cur);
    if (m && Object.values(m.parts).includes(id)) return cur;
    cur = parentOf(cur) ?? null;
  }
  return null;
}

/** Thrown (backend) / shown (editor) when a write would move a part. */
export const PART_MOVE_REFUSED =
  'This is part of a composite and stays where it is. Dissolve the composite to move it.';
export const PART_DELETE_REFUSED =
  'This is part of a composite and can’t be deleted on its own. Dissolve the composite first, or delete the whole composite.';

// ── Settings ────────────────────────────────────────────────────────────────

export type SettingControl =
  | 'text'
  | 'number'
  | 'slider'
  | 'select'
  | 'color'
  | 'asset'
  | 'account';

/** A field of a part document (dotted path), e.g. the caption's
 *  `config.content` or `descriptor.nodes.ev.defaultConfig.account` on the
 *  queue graph. With `cssVar`, the field is a CSS string and the link is the
 *  custom property of that name declared in it. */
export interface SettingLink {
  part: string;
  path: string;
  cssVar?: string;
}

/** One field write: a dotted path on a document, `null` deletes a keyed
 *  element (idMap semantics). */
export interface FieldWrite {
  rtype: PartRtype;
  id: string;
  path: string;
  value: unknown;
}

/** What a setting sees: the marker plus a document lookup. */
export interface CompositeView {
  rtype: CompositeRootRtype;
  rootId: string;
  marker: CompositeMarker;
  get(rtype: PartRtype, id: string): Doc | undefined;
}

export interface CompositeSetting {
  key: string;
  control: SettingControl;
  /** Section heading key (`composites:group.<group>`). */
  group: string;
  /** Select options (labels: `composites:option.<key>.<option>`). */
  options?: string[];
  assetKind?: 'image' | 'video' | 'audio';
  min?: number;
  max?: number;
  step?: number;
  /** Slider shown as 0–100 %. */
  percent?: boolean;
  links?: SettingLink[];
  get?: (v: CompositeView) => unknown;
  set?: (v: CompositeView, value: unknown) => FieldWrite[];
  /** Shown only when this holds (e.g. the account only for platform
   *  triggers). Receives the other settings' current values. */
  when?: (read: (key: string) => unknown) => boolean;
}

export interface CompositeTypeDef {
  type: string;
  rootRtype: CompositeRootRtype;
  /** role → document type of the part. */
  parts: Record<string, PartRtype>;
  settings: CompositeSetting[];
}

/** The document playing `role`, or undefined when it is gone. */
export function partDoc(
  v: CompositeView,
  def: CompositeTypeDef,
  role: string
): { rtype: PartRtype; id: string; doc: Doc } | undefined {
  const rtype = def.parts[role];
  const id = v.marker.parts[role];
  if (!rtype || !id) return undefined;
  const doc = v.get(rtype, id);
  return doc ? { rtype, id, doc } : undefined;
}

// CSS custom properties: `--name: value;` inside a CSS string. Only plain
// declarations are matched; the value runs to the next `;` or `}`.
const cssVarPattern = (name: string) =>
  new RegExp(`(${name.replace(/[-]/g, '\\-')}\\s*:\\s*)([^;}]*)`);

export function readCssVar(css: unknown, name: string): string | undefined {
  if (typeof css !== 'string') return undefined;
  const m = cssVarPattern(name).exec(css);
  return m ? m[2].trim() : undefined;
}

/** `css` with the custom property `name` set to `value`; unchanged when the
 *  property isn't declared (the composite's CSS declares every one it links). */
export function writeCssVar(css: string, name: string, value: string): string {
  const safe = value.replace(/[;{}]/g, '');
  return css.replace(cssVarPattern(name), (_m, head: string) => head + safe);
}

function readLink(v: CompositeView, def: CompositeTypeDef, l: SettingLink) {
  const p = partDoc(v, def, l.part);
  if (!p) return undefined;
  const raw = getPath(p.doc, l.path);
  return l.cssVar ? readCssVar(raw, l.cssVar) : raw;
}

/** A setting's current value: read through its first link. Undefined when
 *  what it points at is gone (the editor shows it as unavailable). */
export function readSetting(
  v: CompositeView,
  def: CompositeTypeDef,
  s: CompositeSetting
): unknown {
  if (s.get) return s.get(v);
  const first = s.links?.[0];
  return first ? readLink(v, def, first) : undefined;
}

/** The writes that set a setting: every link that still exists. */
export function writeSetting(
  v: CompositeView,
  def: CompositeTypeDef,
  s: CompositeSetting,
  value: unknown
): FieldWrite[] {
  if (s.set) return s.set(v, value);
  const out: FieldWrite[] = [];
  for (const l of s.links ?? []) {
    const p = partDoc(v, def, l.part);
    if (!p) continue;
    if (l.cssVar) {
      const css = getPath(p.doc, l.path);
      if (typeof css !== 'string' || readCssVar(css, l.cssVar) === undefined)
        continue;
      out.push({
        rtype: p.rtype,
        id: p.id,
        path: l.path,
        value: writeCssVar(css, l.cssVar, String(value)),
      });
    } else out.push({ rtype: p.rtype, id: p.id, path: l.path, value });
  }
  return out;
}

/** Whether a setting is shown, given the others' current values. */
export function settingVisible(
  v: CompositeView,
  def: CompositeTypeDef,
  s: CompositeSetting
): boolean {
  if (!s.when) return true;
  return s.when((key) => {
    const other = def.settings.find((o) => o.key === key);
    return other ? readSetting(v, def, other) : undefined;
  });
}

// ── Helpers for code-defined settings ──────────────────────────────────────

function graphNode(
  v: CompositeView,
  def: CompositeTypeDef,
  role: string,
  nodeId: string
): GraphNodeDescriptor | undefined {
  const p = partDoc(v, def, role);
  if (!p) return undefined;
  return toGraphDescriptor(
    p.doc.descriptor as Parameters<typeof toGraphDescriptor>[0]
  ).nodes.find((n) => n.id === nodeId);
}

interface KeyframeDoc {
  id: string;
  t: number;
}
interface LaneDoc {
  id: string;
  keyframes?: IdMap<KeyframeDoc>;
}
interface ClipEventDoc {
  id: string;
  t: number;
  action: string;
  targetKind: string;
  targetId: string;
  payload?: unknown;
}

/** The single lane's keyframes in time order. */
function clipKeyframes(
  clip: Doc
): { laneId: string; keys: KeyframeDoc[] } | undefined {
  const lanes = itemsOf(clip.lanes as IdMap<LaneDoc> | undefined);
  const lane = lanes[0];
  if (!lane) return undefined;
  const keys = itemsOf(lane.keyframes).sort((a, b) => a.t - b.t);
  return { laneId: lane.id, keys };
}

const num = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

// ── Alert ───────────────────────────────────────────────────────────────────
//
// One alert type for every trigger (decided, user 2026-11-08). The trigger is
// the head node `ev` of the queue graph; switching it replaces that node and
// its edges into the graph. Every trigger hands its event record to the
// Message template (`text_format`, node `fmt`) as values, so `${displayName}`
// works for a sub and any payload field for a named trigger; a named
// trigger's raw payload is also `${payload}`.

export const ALERT_TRIGGERS = [
  'donation',
  'tip',
  'sub',
  'raid',
  'named',
] as const;
export type AlertTrigger = (typeof ALERT_TRIGGERS)[number];

interface TriggerSpec {
  kind: string;
  defaultConfig: Record<string, unknown>;
  /** Output port carrying the event record. */
  dataPort: string;
}

export const ALERT_TRIGGER_SPECS: Record<AlertTrigger, TriggerSpec> = {
  donation: {
    kind: 'overlive_redemption',
    defaultConfig: { account: '', currencyKind: '', rewardId: '' },
    dataPort: 'data',
  },
  tip: {
    kind: 'overlive_redemption',
    defaultConfig: { account: '', currencyKind: 'tip', rewardId: '' },
    dataPort: 'data',
  },
  sub: {
    kind: 'overlive_subscription',
    defaultConfig: { account: '', tier: '', isGift: '' },
    dataPort: 'data',
  },
  raid: {
    kind: 'overlive_raid',
    defaultConfig: { account: '' },
    dataPort: 'data',
  },
  named: {
    kind: 'on_trigger',
    defaultConfig: { name: 'alert' },
    dataPort: 'payload',
  },
};

/** The trigger node's edges into the alert's queue graph. */
export function alertTriggerEdges(
  trigger: AlertTrigger
): GraphEdgeDescriptor[] {
  const port = ALERT_TRIGGER_SPECS[trigger].dataPort;
  const e = (
    fromPort: string,
    toNodeId: string,
    toPort: string,
    kind: 'event' | 'value'
  ) =>
    ({
      fromNodeId: 'ev',
      fromPort,
      toNodeId,
      toPort,
      kind,
    }) as GraphEdgeDescriptor;
  return [
    e('event', 'pack', 'fire', 'event'),
    e(port, 'fmt', 'values', 'value'),
    ...(trigger === 'named' ? [e('payload', 'fmt', 'payload', 'value')] : []),
  ];
}

function readTrigger(
  node: GraphNodeDescriptor | undefined
): AlertTrigger | undefined {
  if (!node) return undefined;
  const cfg = (node.defaultConfig ?? {}) as Doc;
  switch (node.kind) {
    case 'overlive_redemption':
      return cfg.currencyKind === 'tip' ? 'tip' : 'donation';
    case 'overlive_subscription':
      return 'sub';
    case 'overlive_raid':
      return 'raid';
    case 'on_trigger':
      return 'named';
    default:
      return undefined;
  }
}

const isPlatform = (read: (k: string) => unknown) =>
  read('trigger') !== undefined && read('trigger') !== 'named';

const evPath = (port: string) => `descriptor.nodes.ev.defaultConfig.${port}`;

export const ALERT_COMPOSITE: CompositeTypeDef = {
  type: 'alert',
  rootRtype: 'compose_layer',
  parts: {
    badgeImage: 'compose_layer',
    badgeVideo: 'compose_layer',
    caption: 'compose_layer',
    sound: 'compose_layer',
    fade: 'track_clip',
    queue: 'logic',
  },
  settings: [
    // ── Trigger ──
    {
      key: 'trigger',
      control: 'select',
      group: 'trigger',
      options: [...ALERT_TRIGGERS],
      get(v) {
        return readTrigger(graphNode(v, ALERT_COMPOSITE, 'queue', 'ev'));
      },
      set(v, value) {
        const next = value as AlertTrigger;
        const spec = ALERT_TRIGGER_SPECS[next];
        const p = partDoc(v, ALERT_COMPOSITE, 'queue');
        if (!spec || !p) return [];
        const g = toGraphDescriptor(
          p.doc.descriptor as Parameters<typeof toGraphDescriptor>[0]
        );
        const prev = g.nodes.find((n) => n.id === 'ev');
        if (readTrigger(prev) === next) return [];
        const prevCfg = (prev?.defaultConfig ?? {}) as Doc;
        const cfg: Doc = { ...spec.defaultConfig };
        // Keep what carries over: the account between platform triggers.
        if ('account' in cfg && typeof prevCfg.account === 'string')
          cfg.account = prevCfg.account;
        const node: GraphNodeDescriptor = {
          id: 'ev',
          kind: spec.kind,
          position: prev?.position ?? { x: 0, y: 0 },
          defaultConfig: cfg,
        } as GraphNodeDescriptor;
        const w = (path: string, value: unknown): FieldWrite => ({
          rtype: 'logic',
          id: p.id,
          path,
          value,
        });
        const out: FieldWrite[] = [];
        const nextEdges = alertTriggerEdges(next);
        const nextKeys = new Set(nextEdges.map(edgeKey));
        for (const e of g.edges)
          if (e.fromNodeId === 'ev' && !nextKeys.has(edgeKey(e)))
            out.push(w(`descriptor.edges.${edgeKey(e)}`, null));
        out.push(w('descriptor.nodes.ev', node));
        for (const e of nextEdges)
          out.push(w(`descriptor.edges.${edgeKey(e)}`, e));
        return out;
      },
    },
    {
      key: 'triggerName',
      control: 'text',
      group: 'trigger',
      links: [{ part: 'queue', path: evPath('name') }],
      when: (read) => read('trigger') === 'named',
    },
    {
      key: 'account',
      control: 'account',
      group: 'trigger',
      links: [{ part: 'queue', path: evPath('account') }],
      when: isPlatform,
    },
    {
      key: 'currency',
      control: 'select',
      group: 'trigger',
      options: ['', 'bits', 'channel_points', 'superchat'],
      links: [{ part: 'queue', path: evPath('currencyKind') }],
      when: (read) => read('trigger') === 'donation',
    },
    {
      key: 'rewardId',
      control: 'text',
      group: 'trigger',
      links: [{ part: 'queue', path: evPath('rewardId') }],
      when: (read) =>
        read('trigger') === 'donation' || read('trigger') === 'tip',
    },
    {
      key: 'tier',
      control: 'select',
      group: 'trigger',
      options: ['', 'tier1', 'tier2', 'tier3', 'prime'],
      links: [{ part: 'queue', path: evPath('tier') }],
      when: (read) => read('trigger') === 'sub',
    },
    {
      key: 'gift',
      control: 'select',
      group: 'trigger',
      options: ['', 'true', 'false'],
      links: [{ part: 'queue', path: evPath('isGift') }],
      when: (read) => read('trigger') === 'sub',
    },
    // ── Text ──
    {
      key: 'message',
      control: 'text',
      group: 'text',
      links: [
        { part: 'queue', path: 'descriptor.nodes.fmt.defaultConfig.template' },
        { part: 'caption', path: 'config.content' },
      ],
    },
    {
      key: 'fontFamily',
      control: 'text',
      group: 'text',
      links: [{ part: 'caption', path: 'config.fontFamily' }],
    },
    {
      key: 'fontSize',
      control: 'number',
      group: 'text',
      min: 1,
      step: 1,
      links: [{ part: 'caption', path: 'config.fontSize' }],
    },
    {
      key: 'textColor',
      control: 'color',
      group: 'text',
      links: [{ part: 'caption', path: 'config.color' }],
    },
    // ── Badge ──
    {
      key: 'badgeType',
      control: 'select',
      group: 'badge',
      options: ['image', 'video'],
      get(v) {
        const video = partDoc(v, ALERT_COMPOSITE, 'badgeVideo');
        const image = partDoc(v, ALERT_COMPOSITE, 'badgeImage');
        if (!video && !image) return undefined;
        return video?.doc.visible === true ? 'video' : 'image';
      },
      set(v, value) {
        const video = value === 'video';
        const out: FieldWrite[] = [];
        const img = partDoc(v, ALERT_COMPOSITE, 'badgeImage');
        const vid = partDoc(v, ALERT_COMPOSITE, 'badgeVideo');
        if (img)
          out.push({
            rtype: img.rtype,
            id: img.id,
            path: 'visible',
            value: !video,
          });
        if (vid)
          out.push({
            rtype: vid.rtype,
            id: vid.id,
            path: 'visible',
            value: video,
          });
        // The fade clip restarts the video only while it is the badge: a
        // hidden video would otherwise keep decoding on every alert.
        const clip = partDoc(v, ALERT_COMPOSITE, 'fade');
        if (clip && vid) {
          const events = itemsOf(
            clip.doc.events as IdMap<ClipEventDoc> | undefined
          );
          const marker = events.find(
            (e) => e.targetId === vid.id && e.action === 'restart'
          );
          if (video && !marker) {
            const id = `${vid.id}-restart`;
            out.push({
              rtype: 'track_clip',
              id: clip.id,
              path: `events.${id}`,
              value: {
                id,
                t: 0,
                action: 'restart',
                targetKind: 'compose_layer',
                targetId: vid.id,
                payload: null,
              },
            });
          } else if (!video && marker)
            out.push({
              rtype: 'track_clip',
              id: clip.id,
              path: `events.${marker.id}`,
              value: null,
            });
        }
        return out;
      },
    },
    {
      key: 'image',
      control: 'asset',
      assetKind: 'image',
      group: 'badge',
      links: [{ part: 'badgeImage', path: 'assetId' }],
      when: (read) => read('badgeType') !== 'video',
    },
    {
      key: 'video',
      control: 'asset',
      assetKind: 'video',
      group: 'badge',
      links: [{ part: 'badgeVideo', path: 'assetId' }],
      when: (read) => read('badgeType') === 'video',
    },
    // ── Sound ──
    {
      key: 'sound',
      control: 'asset',
      assetKind: 'audio',
      group: 'sound',
      links: [{ part: 'sound', path: 'assetId' }],
    },
    {
      key: 'volume',
      control: 'slider',
      group: 'sound',
      min: 0,
      max: 1,
      step: 0.05,
      percent: true,
      links: [{ part: 'sound', path: 'config.volume' }],
    },
    // ── Timing ──
    {
      key: 'showFor',
      control: 'number',
      group: 'timing',
      min: 0.5,
      step: 0.5,
      // The fade clip is in → hold → out: keyframes at 0, fadeIn, D − fadeOut,
      // D. "Show for" is D; the fades keep their length.
      get(v) {
        const clip = partDoc(v, ALERT_COMPOSITE, 'fade');
        const d = clip?.doc.duration;
        return typeof d === 'number' && Number.isFinite(d) ? d : undefined;
      },
      set(v, value) {
        const clip = partDoc(v, ALERT_COMPOSITE, 'fade');
        const d = Number(value);
        if (!clip || !Number.isFinite(d) || d <= 0) return [];
        const out: FieldWrite[] = [
          { rtype: 'track_clip', id: clip.id, path: 'duration', value: d },
        ];
        const k = clipKeyframes(clip.doc);
        if (k && k.keys.length === 4) {
          const [, inEnd, outStart, end] = k.keys;
          const fadeOut = Math.max(0, end.t - outStart.t);
          const hold = Math.max(inEnd.t, d - fadeOut);
          const kfPath = (id: string) => `lanes.${k.laneId}.keyframes.${id}.t`;
          out.push(
            {
              rtype: 'track_clip',
              id: clip.id,
              path: kfPath(outStart.id),
              value: hold,
            },
            { rtype: 'track_clip', id: clip.id, path: kfPath(end.id), value: d }
          );
        }
        return out;
      },
    },
    {
      key: 'gap',
      control: 'number',
      group: 'timing',
      min: 0.5,
      step: 0.5,
      // The queue releases one alert per clock tick: gap = 1 / hz.
      get(v) {
        const clock = graphNode(v, ALERT_COMPOSITE, 'queue', 'clock');
        if (!clock) return undefined;
        const hz = num((clock.defaultConfig as Doc | undefined)?.hz, 0.2);
        return hz > 0 ? Math.round((1 / hz) * 100) / 100 : undefined;
      },
      set(v, value) {
        const p = partDoc(v, ALERT_COMPOSITE, 'queue');
        const gap = Number(value);
        if (!p || !Number.isFinite(gap) || gap <= 0) return [];
        return [
          {
            rtype: 'logic',
            id: p.id,
            path: 'descriptor.nodes.clock.defaultConfig.hz',
            value: 1 / gap,
          },
        ];
      },
    },
  ],
};

// ── Chat overlays ───────────────────────────────────────────────────────────
//
// The look lives in the feed's CSS, which the composite version declares as
// custom properties on `.chat` so settings can address them.

const chatLookSettings = (
  cssPart: string,
  cssPath: string
): CompositeSetting[] => [
  {
    key: 'fontFamily',
    control: 'text',
    group: 'look',
    links: [{ part: cssPart, path: cssPath, cssVar: '--chat-font' }],
  },
  {
    key: 'fontSize',
    control: 'text',
    group: 'look',
    links: [{ part: cssPart, path: cssPath, cssVar: '--chat-size' }],
  },
  {
    key: 'textColor',
    control: 'color',
    group: 'look',
    links: [{ part: cssPart, path: cssPath, cssVar: '--chat-color' }],
  },
  {
    key: 'bubbleColor',
    control: 'color',
    group: 'look',
    links: [{ part: cssPart, path: cssPath, cssVar: '--chat-bubble' }],
  },
];

const chatFeedSettings: CompositeSetting[] = [
  {
    key: 'account',
    control: 'account',
    group: 'chat',
    links: [
      { part: 'feed', path: 'descriptor.nodes.feed.defaultConfig.account' },
    ],
  },
  {
    key: 'maxMessages',
    control: 'number',
    group: 'chat',
    min: 1,
    step: 1,
    links: [
      { part: 'feed', path: 'descriptor.nodes.feed.defaultConfig.maxLength' },
    ],
  },
];

export const CHAT_OVERLAY_COMPOSITE: CompositeTypeDef = {
  type: 'chat_overlay',
  rootRtype: 'compose_layer',
  parts: { panel: 'compose_layer', feed: 'logic' },
  settings: [...chatFeedSettings, ...chatLookSettings('panel', 'config.css')],
};

export const CHAT_OVERLAY_3D_COMPOSITE: CompositeTypeDef = {
  type: 'chat_overlay_3d',
  rootRtype: 'scene_node',
  parts: { panel: 'scene_node', feed: 'logic' },
  settings: [
    ...chatFeedSettings,
    ...chatLookSettings('panel', 'components.feed.css'),
  ],
};

export const SCROLLING_CHAT_COMPOSITE: CompositeTypeDef = {
  type: 'scrolling_chat',
  rootRtype: 'scene_node',
  parts: { message: 'scene_node', scroll: 'track_clip', flow: 'logic' },
  settings: [
    {
      key: 'account',
      control: 'account',
      group: 'chat',
      links: [
        { part: 'flow', path: 'descriptor.nodes.chat.defaultConfig.account' },
      ],
    },
    {
      key: 'fontSize',
      control: 'number',
      group: 'look',
      min: 1,
      step: 1,
      links: [{ part: 'message', path: 'components.text.fontSize' }],
    },
    {
      key: 'textColor',
      control: 'color',
      group: 'look',
      links: [{ part: 'message', path: 'components.text.color' }],
    },
    {
      key: 'crossTime',
      control: 'number',
      group: 'motion',
      min: 0.5,
      step: 0.5,
      // The sweep is one lane from the right edge to the left over the whole
      // clip: crossing time is the clip length, and the last keyframe moves
      // with it.
      get(v) {
        const clip = partDoc(v, SCROLLING_CHAT_COMPOSITE, 'scroll');
        return clip ? (clip.doc.duration as number | undefined) : undefined;
      },
      set(v, value) {
        const clip = partDoc(v, SCROLLING_CHAT_COMPOSITE, 'scroll');
        const d = Number(value);
        if (!clip || !Number.isFinite(d) || d <= 0) return [];
        const out: FieldWrite[] = [
          { rtype: 'track_clip', id: clip.id, path: 'duration', value: d },
        ];
        const k = clipKeyframes(clip.doc);
        const last = k?.keys[k.keys.length - 1];
        if (k && last && k.keys.length > 1)
          out.push({
            rtype: 'track_clip',
            id: clip.id,
            path: `lanes.${k.laneId}.keyframes.${last.id}.t`,
            value: d,
          });
        return out;
      },
    },
    {
      key: 'heightMin',
      control: 'number',
      group: 'motion',
      step: 0.1,
      links: [{ part: 'flow', path: 'descriptor.nodes.ry.defaultConfig.min' }],
    },
    {
      key: 'heightMax',
      control: 'number',
      group: 'motion',
      step: 0.1,
      links: [{ part: 'flow', path: 'descriptor.nodes.ry.defaultConfig.max' }],
    },
    {
      key: 'depthMin',
      control: 'number',
      group: 'motion',
      step: 0.1,
      links: [{ part: 'flow', path: 'descriptor.nodes.rz.defaultConfig.min' }],
    },
    {
      key: 'depthMax',
      control: 'number',
      group: 'motion',
      step: 0.1,
      links: [{ part: 'flow', path: 'descriptor.nodes.rz.defaultConfig.max' }],
    },
  ],
};

export const COMPOSITE_TYPES: Record<string, CompositeTypeDef> = {
  [ALERT_COMPOSITE.type]: ALERT_COMPOSITE,
  [CHAT_OVERLAY_COMPOSITE.type]: CHAT_OVERLAY_COMPOSITE,
  [CHAT_OVERLAY_3D_COMPOSITE.type]: CHAT_OVERLAY_3D_COMPOSITE,
  [SCROLLING_CHAT_COMPOSITE.type]: SCROLLING_CHAT_COMPOSITE,
};

/** The type definition behind a marker, or undefined for an unknown type (a
 *  newer save opened by an older build): the root then behaves as a plain
 *  parent. */
export const compositeTypeOf = (
  marker: CompositeMarker | null
): CompositeTypeDef | undefined =>
  marker ? COMPOSITE_TYPES[marker.type] : undefined;

/** The write that dissolves a composite: drop the marker. Its parts become
 *  ordinary children, unprotected. */
export function dissolveWrite(
  rtype: CompositeRootRtype,
  rootId: string
): {
  rtype: CompositeRootRtype;
  id: string;
  path: string;
  value: null;
} {
  return { rtype, id: rootId, path: MARKER_PATH[rtype], value: null };
}
