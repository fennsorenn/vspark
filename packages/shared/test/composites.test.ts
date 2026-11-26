import { describe, it, expect } from 'vitest';
import {
  AD_BREAK_COMPOSITE,
  ALERT_COMPOSITE,
  CHAT_OVERLAY_COMPOSITE,
  COMPOSITE_TYPES,
  COUNTDOWN_COMPOSITE,
  EVENT_SOURCE_SPECS,
  GOAL_COMPOSITE,
  NO_CAP,
  RECENT_EVENTS_COMPOSITE,
  SUBATHON_COMPOSITE,
  TOP_SUPPORTERS_COMPOSITE,
  readSource,
  swapNodeWrites,
  SCROLLING_CHAT_COMPOSITE,
  alertTriggerEdges,
  compositeMarkerOf,
  compositeTypeOf,
  dissolveWrite,
  getPath,
  owningComposite,
  readCssVar,
  readSetting,
  settingVisible,
  writeCssVar,
  writeSetting,
  type CompositeSetting,
  type CompositeTypeDef,
  type CompositeView,
  type FieldWrite,
  type PartRtype,
} from '../src/composites';
import { edgeKey } from '../src/signal';

type Doc = Record<string, unknown>;

/** A view over an in-memory document set, plus a helper that applies writes
 *  the way the mesh does (dotted path set; null deletes a keyed element). */
function world(
  docs: Record<string, Doc>,
  rootId: string,
  rtype: CompositeView['rtype']
) {
  const view = (): CompositeView => ({
    rtype,
    rootId,
    marker: compositeMarkerOf(rtype, docs[rootId])!,
    get: (_r: PartRtype, id: string) => docs[id],
  });
  const apply = (writes: FieldWrite[]) => {
    for (const w of writes) {
      const keys = w.path.split('.');
      let cur = docs[w.id] as Doc;
      for (const k of keys.slice(0, -1)) {
        if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
        cur = cur[k] as Doc;
      }
      const last = keys[keys.length - 1];
      if (w.value === null) delete cur[last];
      else cur[last] = w.value;
    }
  };
  const setting = (def: CompositeTypeDef, key: string): CompositeSetting =>
    def.settings.find((s) => s.key === key)!;
  const read = (def: CompositeTypeDef, key: string) =>
    readSetting(view(), def, setting(def, key));
  const write = (def: CompositeTypeDef, key: string, value: unknown) => {
    const w = writeSetting(view(), def, setting(def, key), value);
    apply(w);
    return w;
  };
  const visible = (def: CompositeTypeDef, key: string) =>
    settingVisible(view(), def, setting(def, key));
  return { docs, view, read, write, visible };
}

function alertWorld() {
  const edges: Doc = {};
  for (const e of [
    ...alertTriggerEdges('raid'),
    {
      fromNodeId: 'fmt',
      fromPort: 'text',
      toNodeId: 'pack',
      toPort: 'text',
      kind: 'value',
    },
  ])
    edges[edgeKey(e as never)] = e;
  return world(
    {
      root: {
        id: 'root',
        config: {
          opacity: 0,
          composite: {
            type: 'alert',
            parts: {
              badgeImage: 'img',
              badgeVideo: 'vid',
              caption: 'cap',
              sound: 'snd',
              fade: 'clip',
              queue: 'g',
            },
          },
        },
      },
      img: { id: 'img', assetId: 'a1', visible: true, config: {} },
      vid: { id: 'vid', assetId: null, visible: false, config: {} },
      cap: { id: 'cap', config: { content: '${displayName}', fontSize: 40 } },
      snd: { id: 'snd', assetId: null, config: { volume: 1 } },
      clip: {
        id: 'clip',
        duration: 4.5,
        lanes: {
          ln: {
            id: 'ln',
            keyframes: {
              k1: { id: 'k1', t: 0 },
              k2: { id: 'k2', t: 0.5 },
              k3: { id: 'k3', t: 4 },
              k4: { id: 'k4', t: 4.5 },
            },
          },
        },
        events: {
          e1: {
            id: 'e1',
            t: 0,
            action: 'restart',
            targetKind: 'compose_layer',
            targetId: 'snd',
          },
        },
      },
      g: {
        id: 'g',
        descriptor: {
          nodes: {
            ev: {
              id: 'ev',
              kind: 'overlive_raid',
              position: { x: 0, y: 0 },
              defaultConfig: { account: 'acc1' },
            },
            fmt: {
              id: 'fmt',
              kind: 'text_format',
              position: { x: 1, y: 0 },
              defaultConfig: {
                template: '${displayName}',
                fields: ['payload'],
              },
            },
            clock: {
              id: 'clock',
              kind: 'clock',
              position: { x: 2, y: 1 },
              defaultConfig: { hz: 0.2 },
            },
          },
          edges,
        },
      },
    },
    'root',
    'compose_layer'
  );
}

describe('composite markers', () => {
  it('reads the marker from a layer config or a node properties bag', () => {
    expect(
      compositeMarkerOf('compose_layer', {
        config: { composite: { type: 'alert', parts: { a: 'x', b: 7 } } },
      })
    ).toEqual({ type: 'alert', parts: { a: 'x' } });
    expect(
      compositeMarkerOf('scene_node', {
        properties: { composite: { type: 'chat_overlay_3d', parts: {} } },
      })?.type
    ).toBe('chat_overlay_3d');
    expect(
      compositeMarkerOf('scene_node', {
        components: { composite: { type: 'x', parts: {} } },
      })
    ).toBeNull();
    expect(compositeMarkerOf('logic', {})).toBeNull();
    expect(
      compositeMarkerOf('compose_layer', { config: { composite: null } })
    ).toBeNull();
  });

  it('knows the built-in types and ignores unknown ones', () => {
    expect(compositeTypeOf({ type: 'alert', parts: {} })).toBe(ALERT_COMPOSITE);
    expect(compositeTypeOf({ type: 'nope', parts: {} })).toBeUndefined();
    expect(compositeTypeOf(null)).toBeUndefined();
  });

  it('dissolves by clearing the marker', () => {
    expect(dissolveWrite('scene_node', 'n1')).toEqual({
      rtype: 'scene_node',
      id: 'n1',
      path: 'properties.composite',
      value: null,
    });
  });
});

describe('part protection', () => {
  const parent: Record<string, string | null> = {
    cap: 'root',
    sub: 'root',
    deep: 'sub',
    root: 'scene',
  };
  const markers: Record<string, ReturnType<typeof compositeMarkerOf>> = {
    root: { type: 'alert', parts: { caption: 'cap', inner: 'deep' } },
  };
  const owner = (id: string) =>
    owningComposite(
      id,
      parent[id],
      (x) => parent[x],
      (x) => markers[x] ?? null
    );

  it('finds the composite listing an entity, searching up from its parent', () => {
    expect(owner('cap')).toBe('root');
    expect(owner('deep')).toBe('root');
    expect(owner('sub')).toBeNull(); // a child that isn't a listed part
    expect(owner('root')).toBeNull();
  });

  it('survives a parent cycle', () => {
    expect(
      owningComposite(
        'a',
        'b',
        (x) => (x === 'b' ? 'c' : 'b'),
        () => null
      )
    ).toBeNull();
  });
});

describe('css custom properties', () => {
  const css = '.chat { --chat-font: system-ui, sans-serif; --chat-size:16px }';
  it('reads and writes a declaration in place', () => {
    expect(readCssVar(css, '--chat-font')).toBe('system-ui, sans-serif');
    expect(readCssVar(css, '--chat-size')).toBe('16px');
    expect(readCssVar(css, '--nope')).toBeUndefined();
    expect(readCssVar(42, '--chat-size')).toBeUndefined();
    const next = writeCssVar(css, '--chat-size', '20px');
    expect(readCssVar(next, '--chat-size')).toBe('20px');
    expect(readCssVar(next, '--chat-font')).toBe('system-ui, sans-serif');
  });
  it('cannot break out of the declaration', () => {
    const next = writeCssVar(css, '--chat-size', '1px; } body { x: y');
    expect(next).not.toContain('body {');
  });
});

describe('alert settings', () => {
  it('reads and writes a field link to every target', () => {
    const w = alertWorld();
    expect(w.read(ALERT_COMPOSITE, 'message')).toBe('${displayName}');
    const writes = w.write(
      ALERT_COMPOSITE,
      'message',
      '${displayName} raided!'
    );
    expect(writes).toHaveLength(2);
    expect(
      getPath(w.docs.g, 'descriptor.nodes.fmt.defaultConfig.template')
    ).toBe('${displayName} raided!');
    expect(getPath(w.docs.cap, 'config.content')).toBe(
      '${displayName} raided!'
    );
  });

  it('reads an unset field of an existing part as null, not as gone', () => {
    const w = alertWorld();
    expect(w.read(ALERT_COMPOSITE, 'fontFamily')).toBeNull();
    expect(w.write(ALERT_COMPOSITE, 'fontFamily', 'serif')).toHaveLength(1);
  });

  it('shows a setting as unavailable when its part is gone, and skips it on write', () => {
    const w = alertWorld();
    delete w.docs.snd;
    expect(w.read(ALERT_COMPOSITE, 'volume')).toBeUndefined();
    expect(w.write(ALERT_COMPOSITE, 'volume', 0.5)).toEqual([]);
  });

  it('switches the trigger by replacing the head node and its edges', () => {
    const w = alertWorld();
    expect(w.read(ALERT_COMPOSITE, 'trigger')).toBe('raid');
    expect(w.visible(ALERT_COMPOSITE, 'account')).toBe(true);
    expect(w.visible(ALERT_COMPOSITE, 'triggerName')).toBe(false);

    w.write(ALERT_COMPOSITE, 'trigger', 'named');
    const g = w.docs.g.descriptor as { nodes: Doc; edges: Doc };
    expect((g.nodes.ev as Doc).kind).toBe('on_trigger');
    expect(Object.keys(g.edges).sort()).toEqual(
      [
        'ev:event:pack:fire',
        'ev:payload:fmt:values',
        'ev:payload:fmt:payload',
        'fmt:text:pack:text',
      ].sort()
    );
    expect(w.read(ALERT_COMPOSITE, 'trigger')).toBe('named');
    expect(w.visible(ALERT_COMPOSITE, 'account')).toBe(false);
    expect(w.read(ALERT_COMPOSITE, 'triggerName')).toBe('alert');

    // Back to a platform trigger: the data edge returns, the payload ones go.
    w.write(ALERT_COMPOSITE, 'trigger', 'sub');
    expect(
      Object.keys((w.docs.g.descriptor as { edges: Doc }).edges).sort()
    ).toEqual(
      ['ev:data:fmt:values', 'ev:event:pack:fire', 'fmt:text:pack:text'].sort()
    );
    expect(w.visible(ALERT_COMPOSITE, 'tier')).toBe(true);
    expect(w.visible(ALERT_COMPOSITE, 'currency')).toBe(false);
  });

  it('carries the account over between platform triggers; tip is a redemption in tips', () => {
    const w = alertWorld();
    w.write(ALERT_COMPOSITE, 'trigger', 'tip');
    expect(getPath(w.docs.g, 'descriptor.nodes.ev.defaultConfig')).toEqual({
      account: 'acc1',
      currencyKind: 'tip',
      rewardId: '',
    });
    expect(w.read(ALERT_COMPOSITE, 'trigger')).toBe('tip');
    w.write(ALERT_COMPOSITE, 'trigger', 'donation');
    expect(w.read(ALERT_COMPOSITE, 'trigger')).toBe('donation');
    expect(w.visible(ALERT_COMPOSITE, 'currency')).toBe(true);
    expect(w.write(ALERT_COMPOSITE, 'trigger', 'donation')).toEqual([]);
    expect(w.write(ALERT_COMPOSITE, 'trigger', 'bogus')).toEqual([]);
  });

  it('"Show for" sets the clip length and moves the fade-out, keeping the fades', () => {
    const w = alertWorld();
    expect(w.read(ALERT_COMPOSITE, 'showFor')).toBe(4.5);
    w.write(ALERT_COMPOSITE, 'showFor', 8);
    const kfs = getPath(w.docs.clip, 'lanes.ln.keyframes') as Record<
      string,
      { t: number }
    >;
    expect(w.docs.clip.duration).toBe(8);
    expect([kfs.k1.t, kfs.k2.t, kfs.k3.t, kfs.k4.t]).toEqual([0, 0.5, 7.5, 8]);
    expect(w.write(ALERT_COMPOSITE, 'showFor', -1)).toEqual([]);
  });

  it('"Gap between alerts" is the queue clock period', () => {
    const w = alertWorld();
    expect(w.read(ALERT_COMPOSITE, 'gap')).toBe(5);
    w.write(ALERT_COMPOSITE, 'gap', 2);
    expect(getPath(w.docs.g, 'descriptor.nodes.clock.defaultConfig.hz')).toBe(
      0.5
    );
    expect(w.read(ALERT_COMPOSITE, 'gap')).toBe(2);
  });

  it('badge type swaps which badge shows and whether the clip restarts the video', () => {
    const w = alertWorld();
    expect(w.read(ALERT_COMPOSITE, 'badgeType')).toBe('image');
    expect(w.visible(ALERT_COMPOSITE, 'image')).toBe(true);
    w.write(ALERT_COMPOSITE, 'badgeType', 'video');
    expect(w.docs.img.visible).toBe(false);
    expect(w.docs.vid.visible).toBe(true);
    const events = () => Object.values(w.docs.clip.events as Doc) as Doc[];
    expect(events().filter((e) => e.targetId === 'vid')).toHaveLength(1);
    expect(w.visible(ALERT_COMPOSITE, 'video')).toBe(true);
    w.write(ALERT_COMPOSITE, 'badgeType', 'video'); // idempotent
    expect(events().filter((e) => e.targetId === 'vid')).toHaveLength(1);
    w.write(ALERT_COMPOSITE, 'badgeType', 'image');
    expect(events().map((e) => e.targetId)).toEqual(['snd']);
    expect(w.docs.img.visible).toBe(true);
  });
});

describe('chat settings', () => {
  it('writes the look into the CSS custom properties', () => {
    const w = world(
      {
        root: {
          id: 'root',
          config: {
            composite: {
              type: 'chat_overlay',
              parts: { panel: 'root', feed: 'g' },
            },
            css: '.chat{--chat-color:#fff;}',
          },
        },
        g: {
          id: 'g',
          descriptor: {
            nodes: {
              feed: {
                id: 'feed',
                kind: 'overlive_chat_feed',
                defaultConfig: { account: '', maxLength: 50 },
              },
            },
            edges: {},
          },
        },
      },
      'root',
      'compose_layer'
    );
    expect(w.read(CHAT_OVERLAY_COMPOSITE, 'textColor')).toBe('#fff');
    w.write(CHAT_OVERLAY_COMPOSITE, 'textColor', '#ff0000');
    expect(getPath(w.docs.root, 'config.css')).toBe(
      '.chat{--chat-color:#ff0000;}'
    );
    // Not declared → nothing to write.
    expect(w.write(CHAT_OVERLAY_COMPOSITE, 'bubbleColor', '#000')).toEqual([]);
    expect(w.read(CHAT_OVERLAY_COMPOSITE, 'maxMessages')).toBe(50);
  });

  it('scrolling chat crossing time moves the end of the sweep', () => {
    const w = world(
      {
        root: {
          id: 'root',
          properties: {
            composite: {
              type: 'scrolling_chat',
              parts: { message: 'm', scroll: 'c', flow: 'g' },
            },
          },
        },
        c: {
          id: 'c',
          duration: 6,
          lanes: {
            l: {
              id: 'l',
              keyframes: { a: { id: 'a', t: 0 }, b: { id: 'b', t: 6 } },
            },
          },
        },
      },
      'root',
      'scene_node'
    );
    expect(w.read(SCROLLING_CHAT_COMPOSITE, 'crossTime')).toBe(6);
    w.write(SCROLLING_CHAT_COMPOSITE, 'crossTime', 10);
    expect(getPath(w.docs.c, 'lanes.l.keyframes.b.t')).toBe(10);
    expect(w.docs.c.duration).toBe(10);
    expect(w.read(SCROLLING_CHAT_COMPOSITE, 'account')).toBeUndefined();
  });
});

describe('settings edge cases', () => {
  it('reads nothing and writes nothing when the parts are gone', () => {
    const w = alertWorld();
    for (const id of ['g', 'clip', 'img', 'vid'] as const) delete w.docs[id];
    expect(w.read(ALERT_COMPOSITE, 'trigger')).toBeUndefined();
    expect(w.write(ALERT_COMPOSITE, 'trigger', 'raid')).toEqual([]);
    expect(w.read(ALERT_COMPOSITE, 'gap')).toBeUndefined();
    expect(w.write(ALERT_COMPOSITE, 'gap', 3)).toEqual([]);
    expect(w.read(ALERT_COMPOSITE, 'showFor')).toBeUndefined();
    expect(w.write(ALERT_COMPOSITE, 'showFor', 3)).toEqual([]);
    expect(w.read(ALERT_COMPOSITE, 'badgeType')).toBeUndefined();
    expect(w.write(ALERT_COMPOSITE, 'badgeType', 'video')).toEqual([]);
    // Unknown trigger state hides the platform-only settings.
    expect(w.visible(ALERT_COMPOSITE, 'account')).toBe(false);
  });

  it('a graph with a foreign head node reads as no trigger', () => {
    const w = alertWorld();
    (getPath(w.docs.g, 'descriptor.nodes') as Doc).ev = {
      id: 'ev',
      kind: 'clock',
    };
    expect(w.read(ALERT_COMPOSITE, 'trigger')).toBeUndefined();
  });

  it('"Show for" on a reshaped fade clip only sets the length', () => {
    const w = alertWorld();
    (w.docs.clip as Doc).lanes = {};
    expect(w.write(ALERT_COMPOSITE, 'showFor', 6)).toEqual([
      { rtype: 'track_clip', id: 'clip', path: 'duration', value: 6 },
    ]);
  });

  it('a gap or a clock rate of zero is ignored', () => {
    const w = alertWorld();
    expect(w.write(ALERT_COMPOSITE, 'gap', 0)).toEqual([]);
    (getPath(w.docs.g, 'descriptor.nodes.clock') as Doc).defaultConfig = {
      hz: 0,
    };
    expect(w.read(ALERT_COMPOSITE, 'gap')).toBeUndefined();
  });

  it('a CSS link on a part without CSS is skipped', () => {
    const w = world(
      {
        root: {
          id: 'root',
          config: {
            composite: { type: 'chat_overlay', parts: { panel: 'root' } },
          },
        },
      },
      'root',
      'compose_layer'
    );
    expect(w.read(CHAT_OVERLAY_COMPOSITE, 'fontFamily')).toBeUndefined();
    expect(w.write(CHAT_OVERLAY_COMPOSITE, 'fontFamily', 'serif')).toEqual([]);
  });

  it('a setting with no links reads as unavailable; an unknown dependency hides nothing it gates', () => {
    const w = alertWorld();
    const bare = { key: 'x', control: 'text', group: 'g' } as const;
    const def = {
      ...ALERT_COMPOSITE,
      settings: [
        bare,
        {
          ...bare,
          key: 'y',
          when: (r: (k: string) => unknown) => r('missing') === undefined,
        },
      ],
    };
    expect(readSetting(w.view(), def, bare)).toBeUndefined();
    expect(writeSetting(w.view(), def, bare, 1)).toEqual([]);
    expect(settingVisible(w.view(), def, def.settings[1])).toBe(true);
  });

  it('scrolling chat ignores an invalid crossing time and a missing clip', () => {
    const w = world(
      {
        root: {
          id: 'root',
          properties: {
            composite: { type: 'scrolling_chat', parts: { scroll: 'c' } },
          },
        },
      },
      'root',
      'scene_node'
    );
    expect(w.read(SCROLLING_CHAT_COMPOSITE, 'crossTime')).toBeUndefined();
    expect(w.write(SCROLLING_CHAT_COMPOSITE, 'crossTime', 4)).toEqual([]);
  });

  it('protection lookups tolerate unknown parents', () => {
    expect(
      owningComposite(
        'a',
        'p',
        () => undefined,
        () => null
      )
    ).toBeNull();
    expect(
      owningComposite(
        'a',
        null,
        () => 'x',
        () => null
      )
    ).toBeNull();
  });
});

// ── Stream widgets ──────────────────────────────────────────────────────────


const gnode = (id: string, kind: string, defaultConfig: Doc = {}) => ({
  id,
  kind,
  position: { x: 0, y: 0 },
  defaultConfig,
});
const keyed = (list: { id: string }[]) =>
  Object.fromEntries(list.map((x) => [x.id, x]));
const edges = (list: Parameters<typeof edgeKey>[0][]) =>
  Object.fromEntries(list.map((e) => [edgeKey(e), e]));

function widget(type: string, role: string, nodes: ReturnType<typeof gnode>[], es: Parameters<typeof edgeKey>[0][]) {
  const docs: Record<string, Doc> = {
    root: {
      id: 'root',
      kind: 'feed',
      config: {
        css: '.w { --w-font: a; --w-size: 20px; --w-color: #fff; --w-accent: #f0f; --w-track: #000; }',
        composite: { type, parts: { panel: 'root', [role]: 'g' } },
      },
    },
    g: { id: 'g', descriptor: { nodes: keyed(nodes), edges: edges(es) } },
  };
  return { docs, ...world(docs, 'root', 'compose_layer') };
}
const graphNodes = (docs: Record<string, Doc>) =>
  (docs.g.descriptor as Doc).nodes as Record<string, Doc>;
const graphEdges = (docs: Record<string, Doc>) =>
  Object.keys((docs.g.descriptor as Doc).edges as Doc);

describe('goal widget', () => {
  const make = () =>
    widget(
      'goal',
      'flow',
      [
        gnode('goal', 'overlive_goal', { account: 'a1' }),
        gnode('src', 'overlive_follow', { account: 'a1' }),
        gnode('inc', 'increment_variable', { name: 'goal' }),
        gnode('get', 'variable', { name: 'goal' }),
        gnode('online', 'overlive_stream_online', { account: 'a1' }),
        gnode('zero', 'set_variable', { name: 'goal' }),
        gnode('sd', 'set_data', { fields: ['current', 'target', 'label'] }),
      ],
      [
        { fromNodeId: 'get', fromPort: 'changed', toNodeId: 'sd', toPort: 'fire', kind: 'event' },
        { fromNodeId: 'get', fromPort: 'value', toNodeId: 'sd', toPort: 'current', kind: 'value' },
        { fromNodeId: 'src', fromPort: 'event', toNodeId: 'inc', toPort: 'fire', kind: 'event' },
      ]
    );

  it('switches between a Twitch goal and a manual one by its edges', () => {
    const w = make();
    expect(w.read(GOAL_COMPOSITE, 'source')).toBe('manual');
    w.write(GOAL_COMPOSITE, 'source', 'twitch');
    expect(w.read(GOAL_COMPOSITE, 'source')).toBe('twitch');
    expect(graphEdges(w.docs).some((k) => k.startsWith('get:changed'))).toBe(false);
    expect(
      settingVisible(w.view(), GOAL_COMPOSITE, GOAL_COMPOSITE.settings.find((s) => s.key === 'target')!)
    ).toBe(false);
  });

  it('swaps the counted event, removes it for "none", carries the account', () => {
    const w = make();
    expect(w.read(GOAL_COMPOSITE, 'count')).toBe('follow');
    w.write(GOAL_COMPOSITE, 'count', 'bits');
    expect(graphNodes(w.docs).src.kind).toBe('overlive_redemption');
    expect((graphNodes(w.docs).src.defaultConfig as Doc).account).toBe('a1');
    expect(graphEdges(w.docs)).toContain('src:amount:inc:by');
    expect(w.read(GOAL_COMPOSITE, 'count')).toBe('bits');
    expect(w.write(GOAL_COMPOSITE, 'count', 'bits')).toEqual([]);
    w.write(GOAL_COMPOSITE, 'count', 'none');
    expect(graphNodes(w.docs).src).toBeUndefined();
    expect(graphEdges(w.docs).some((k) => k.startsWith('src:'))).toBe(false);
    expect(w.read(GOAL_COMPOSITE, 'count')).toBe('none');
    // The account now writes only the nodes that exist.
    const writes = w.write(GOAL_COMPOSITE, 'account', 'a2');
    expect(writes.map((x) => x.path)).toEqual([
      'descriptor.nodes.goal.defaultConfig.account',
      'descriptor.nodes.online.defaultConfig.account',
    ]);
  });

  it('per stream resets on stream start; always keeps', () => {
    const w = make();
    expect(w.read(GOAL_COMPOSITE, 'period')).toBe('always');
    w.write(GOAL_COMPOSITE, 'period', 'stream');
    expect(graphEdges(w.docs)).toContain('online:event:zero:fire');
    expect(w.read(GOAL_COMPOSITE, 'period')).toBe('stream');
  });
});

describe('timer widgets', () => {
  const make = () =>
    widget(
      'subathon',
      'flow',
      [
        gnode('dl', 'deadline', { duration: 3600 }),
        gnode('mBits', 'math', { b: 0.6 }),
        gnode('cap', 'math', { a: NO_CAP }),
        gnode('st', 'step_lookup', { steps: [] }),
        gnode('tStart', 'on_trigger', { name: 'subathon start' }),
        gnode('tPause', 'on_trigger', { name: 'subathon pause' }),
        gnode('tResume', 'on_trigger', { name: 'subathon resume' }),
        gnode('tReset', 'on_trigger', { name: 'subathon reset' }),
      ],
      []
    );

  it('names all four control triggers from one base name', () => {
    const w = make();
    expect(w.read(SUBATHON_COMPOSITE, 'controlName')).toBe('subathon');
    w.write(SUBATHON_COMPOSITE, 'controlName', 'marathon');
    expect((graphNodes(w.docs).tPause.defaultConfig as Doc).name).toBe('marathon pause');
    expect(w.read(SUBATHON_COMPOSITE, 'controlName')).toBe('marathon');
  });

  it('shows bits per 100 and no cap as 0', () => {
    const w = make();
    expect(w.read(SUBATHON_COMPOSITE, 'per100Bits')).toBeCloseTo(60);
    w.write(SUBATHON_COMPOSITE, 'per100Bits', 120);
    expect((graphNodes(w.docs).mBits.defaultConfig as Doc).b).toBeCloseTo(1.2);
    expect(w.read(SUBATHON_COMPOSITE, 'hardCap')).toBe(0);
    w.write(SUBATHON_COMPOSITE, 'hardCap', 86400);
    expect(w.read(SUBATHON_COMPOSITE, 'hardCap')).toBe(86400);
    w.write(SUBATHON_COMPOSITE, 'hardCap', 0);
    expect((graphNodes(w.docs).cap.defaultConfig as Doc).a).toBe(NO_CAP);
    expect(w.write(SUBATHON_COMPOSITE, 'hardCap', -1)).toEqual([]);
    expect(w.read(SUBATHON_COMPOSITE, 'controls')).toBe(true);
  });

  it('a countdown counts to a time of day when the until edge is there', () => {
    const w = widget(
      'countdown',
      'timer',
      [gnode('dl', 'deadline'), gnode('dt', 'date_time', { text: '20:00' })],
      []
    );
    expect(w.read(COUNTDOWN_COMPOSITE, 'mode')).toBe('duration');
    w.write(COUNTDOWN_COMPOSITE, 'mode', 'until');
    expect(graphEdges(w.docs)).toEqual(['dt:fromNow:dl:duration']);
    expect(w.read(COUNTDOWN_COMPOSITE, 'until')).toBe('20:00');
    // No trigger nodes: the control name reads as gone.
    expect(w.read(COUNTDOWN_COMPOSITE, 'controlName')).toBeUndefined();
  });
});

describe('recent events widget', () => {
  it('a source is shown when its event reaches the list; its label only then', () => {
    const w = widget(
      'recent_events',
      'flow',
      [gnode('sFollow', 'overlive_follow'), gnode('pFollow', 'pack_event', { label: 'followed' })],
      [{ fromNodeId: 'sFollow', fromPort: 'event', toNodeId: 'pFollow', toPort: 'fire', kind: 'event' }]
    );
    const label = RECENT_EVENTS_COMPOSITE.settings.find((s) => s.key === 'labelFollow')!;
    expect(w.read(RECENT_EVENTS_COMPOSITE, 'showFollow')).toBe(true);
    expect(settingVisible(w.view(), RECENT_EVENTS_COMPOSITE, label)).toBe(true);
    w.write(RECENT_EVENTS_COMPOSITE, 'showFollow', false);
    expect(w.read(RECENT_EVENTS_COMPOSITE, 'showFollow')).toBe(false);
    expect(settingVisible(w.view(), RECENT_EVENTS_COMPOSITE, label)).toBe(false);
    // A source whose nodes are gone reads as off, not as broken.
    expect(w.read(RECENT_EVENTS_COMPOSITE, 'showRaid')).toBe(false);
  });
});

describe('event sources', () => {
  it('reads a node as its source, money nodes by currency', () => {
    for (const [k, spec] of Object.entries(EVENT_SOURCE_SPECS))
      expect(readSource(gnode('x', spec.kind, spec.defaultConfig) as never)).toBe(k);
    expect(
      readSource(gnode('x', 'overlive_redemption', { currencyKind: 'channel_points' }) as never)
    ).toBeUndefined();
    expect(readSource(undefined)).toBeUndefined();
  });

  it('swapping in a node with nothing before puts it and its edges', () => {
    const docs = { g: { descriptor: { nodes: {}, edges: {} } } as Doc };
    const writes = swapNodeWrites('g', docs.g, 'src', EVENT_SOURCE_SPECS.raid, []);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('descriptor.nodes.src');
    expect(swapNodeWrites('g', docs.g, 'src', null, [])).toEqual([]);
  });
});

describe('more widget settings', () => {
  it('top supporters swaps its ranked source and keeps the account', () => {
    const w = widget(
      'top_supporters',
      'flow',
      [
        gnode('src', 'overlive_redemption', { account: 'a1', currencyKind: 'bits' }),
        gnode('online', 'overlive_stream_online', { account: 'a1' }),
        gnode('tl', 'tally', { topCount: 5 }),
        gnode('sd', 'set_data', { title: 'Top' }),
      ],
      []
    );
    expect(w.read(TOP_SUPPORTERS_COMPOSITE, 'metric')).toBe('bits');
    expect(w.read(TOP_SUPPORTERS_COMPOSITE, 'account')).toBe('a1');
    w.write(TOP_SUPPORTERS_COMPOSITE, 'metric', 'gift');
    expect(graphNodes(w.docs).src.kind).toBe('overlive_gift_bomb');
    expect(graphEdges(w.docs).sort()).toEqual([
      'src:count:tl:amount',
      'src:event:tl:add',
      'src:gifterDisplayName:tl:user',
    ]);
    expect(w.write(TOP_SUPPORTERS_COMPOSITE, 'metric', 'gift')).toEqual([]);
    expect(w.write(TOP_SUPPORTERS_COMPOSITE, 'metric', 'bogus')).toEqual([]);
    w.write(TOP_SUPPORTERS_COMPOSITE, 'period', 'stream');
    expect(w.read(TOP_SUPPORTERS_COMPOSITE, 'period')).toBe('stream');
    expect(w.read(TOP_SUPPORTERS_COMPOSITE, 'title')).toBe('Top');
    expect(w.read(TOP_SUPPORTERS_COMPOSITE, 'accentColor')).toBe('#f0f');
  });

  it('ad break: account over both ad nodes, the message', () => {
    const w = widget(
      'ad_break',
      'flow',
      [gnode('ad', 'overlive_ad_start', { account: '' }), gnode('end', 'overlive_ad_end', { account: '' }), gnode('sd', 'set_data', { message: 'Ads' })],
      []
    );
    expect(w.read(AD_BREAK_COMPOSITE, 'account')).toBe('');
    expect(w.write(AD_BREAK_COMPOSITE, 'account', 'a9')).toHaveLength(2);
    expect(w.read(AD_BREAK_COMPOSITE, 'message')).toBe('Ads');
  });

  it('a widget whose graph is gone reads every graph setting as unavailable', () => {
    const w = widget('subathon', 'flow', [], []);
    delete w.docs.g;
    for (const key of ['controls', 'account', 'per100Bits', 'hardCap', 'controlName'])
      expect(w.read(SUBATHON_COMPOSITE, key), key).toBeUndefined();
    expect(w.write(SUBATHON_COMPOSITE, 'per100Bits', 10)).toEqual([]);
    expect(w.write(SUBATHON_COMPOSITE, 'hardCap', 10)).toEqual([]);
    expect(w.write(SUBATHON_COMPOSITE, 'controlName', 'x')).toEqual([]);
    expect(w.write(SUBATHON_COMPOSITE, 'account', 'x')).toEqual([]);
    expect(w.read(GOAL_COMPOSITE, 'source')).toBeUndefined();
    expect(w.write(GOAL_COMPOSITE, 'source', 'twitch')).toEqual([]);
    expect(w.read(GOAL_COMPOSITE, 'count')).toBeUndefined();
    expect(w.write(GOAL_COMPOSITE, 'count', 'sub')).toEqual([]);
    expect(w.read(GOAL_COMPOSITE, 'period')).toBeUndefined();
    expect(w.write(GOAL_COMPOSITE, 'period', 'stream')).toEqual([]);
    expect(w.read(TOP_SUPPORTERS_COMPOSITE, 'metric')).toBeUndefined();
    expect(w.write(TOP_SUPPORTERS_COMPOSITE, 'metric', 'bits')).toEqual([]);
  });

  it('the goal shows its Twitch kind only for a Twitch goal; the counted named trigger only then', () => {
    const w = widget(
      'goal',
      'flow',
      [
        gnode('goal', 'overlive_goal', { kind: 'follow' }),
        gnode('src', 'on_trigger', { name: 'goal' }),
        gnode('get', 'variable', { name: 'goal' }),
        gnode('inc', 'increment_variable', { name: 'goal' }),
        gnode('zero', 'set_variable', { name: 'goal' }),
        gnode('sd', 'set_data', {}),
      ],
      []
    );
    expect(w.read(GOAL_COMPOSITE, 'count')).toBe('named');
    expect(w.visible(GOAL_COMPOSITE, 'countTrigger')).toBe(true);
    expect(w.visible(GOAL_COMPOSITE, 'goalKind')).toBe(false);
    expect(w.read(GOAL_COMPOSITE, 'current')).toBe(true);
    w.write(GOAL_COMPOSITE, 'variable', 'subs');
    for (const id of ['get', 'inc', 'zero'])
      expect((graphNodes(w.docs)[id].defaultConfig as Doc).name).toBe('subs');
    w.write(GOAL_COMPOSITE, 'source', 'twitch');
    expect(w.visible(GOAL_COMPOSITE, 'goalKind')).toBe(true);
    expect(w.visible(GOAL_COMPOSITE, 'countTrigger')).toBe(false);
    expect(w.read(GOAL_COMPOSITE, 'goalKind')).toBe('follow');
  });
});

describe('every composite type', () => {
  it('reads and decides the visibility of every setting without throwing, even on an empty graph', () => {
    for (const def of Object.values(COMPOSITE_TYPES)) {
      const roles = Object.keys(def.parts);
      const graphRole = roles.find((r) => def.parts[r] === 'logic');
      const docs: Record<string, Doc> = {
        root: {
          id: 'root',
          config: {
            composite: {
              type: def.type,
              parts: Object.fromEntries(
                roles.map((r) => [r, r === graphRole ? 'g' : 'root'])
              ),
            },
          },
          properties: {
            composite: {
              type: def.type,
              parts: Object.fromEntries(
                roles.map((r) => [r, r === graphRole ? 'g' : 'root'])
              ),
            },
          },
        },
        g: { id: 'g', descriptor: { nodes: {}, edges: {} } },
      };
      const w = world(docs, 'root', def.rootRtype);
      for (const s of def.settings) {
        expect(() => readSetting(w.view(), def, s), `${def.type}.${s.key}`).not.toThrow();
        expect(typeof settingVisible(w.view(), def, s)).toBe('boolean');
      }
    }
  });
});
