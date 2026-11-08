import { describe, it, expect } from 'vitest';
import {
  ALERT_COMPOSITE,
  CHAT_OVERLAY_COMPOSITE,
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
