// Built-in composites (see dev-notes/plans/composites.md): templates placed
// as one object with its own settings. Each is an ordinary preset payload
// whose root carries the composite marker — `config.composite` on a layer,
// `properties.composite` on a node — naming its type and which entity plays
// which part. The part ids are written with `ref()`, so instantiation remaps
// them like every other id in the payload; the settings themselves live in
// `@vspark/shared/composites`.
//
// The matching plain presets in alerts.ts / chat.ts stay until the composites
// are confirmed to replace them (decided, user 2026-11-08).
import {
  ALERT_TRIGGER_SPECS,
  alertTriggerEdges,
  EVENT_SOURCE_SPECS,
  GOAL_RESET_EDGES,
  goalCountEdges,
  NO_CAP,
  RECENT_RESET_EDGES,
  RECENT_SOURCES,
  recentIds,
  topEdges,
  type AlertTrigger,
  type EventSource,
} from '@vspark/shared/composites';
import type { GraphEdgeDescriptor } from '@vspark/shared/signal';
import {
  clipEvent,
  composeLayer,
  composeLayerPreset,
  edge,
  FEED_CHAT_TEMPLATE,
  gnode,
  graph,
  kf,
  lane,
  ref,
  sceneNode,
  sceneNodePreset,
  trackClip,
  transform,
  type BuiltinPreset,
} from './helpers.js';

export interface BuiltinComposite extends BuiltinPreset {
  /** The composite type the root's marker names. */
  composite: string;
}

const marker = (type: string, parts: Record<string, string>) => ({
  type,
  parts: Object.fromEntries(
    Object.entries(parts).map(([role, presetId]) => [role, ref(presetId)])
  ),
});

// ── Alert ─────────────────────────────────────────────────────────────────
// The alert presets' structure (group fading 0→1→0, caption, hidden sound
// layer, queue graph releasing one alert per clock tick) with both badges in
// one object and the trigger as a setting. The caption text comes from the
// Message template (`fmt`, a Format Text node) filled with the event's data.

const INITIAL_TRIGGER: AlertTrigger = 'donation';

const alert: BuiltinComposite = {
  ...composeLayerPreset(
    'builtin:composite-alert',
    'Alert',
    'An event alert: badge, message and sound fade in on a donation, tip, bits, sub, gift, follow, raid or a named trigger, queued so bursts play one after another.',
    [
      composeLayer('l1', null, 'Alert', 'group', {
        config: {
          opacity: 0,
          composite: marker('alert', {
            badgeImage: 'l2',
            badgeVideo: 'l5',
            caption: 'l3',
            sound: 'l4',
            fade: 'tc1',
            queue: 'g1',
          }),
        },
        width: 320,
        height: 350,
      }),
      composeLayer('l2', 'l1', 'Badge', 'image', {
        config: { objectFit: 'contain', opacity: 1 },
        x: 40,
        y: 0,
        width: 240,
        height: 240,
        order: 0,
      }),
      composeLayer('l5', 'l1', 'Badge Video', 'video', {
        config: {
          objectFit: 'contain',
          opacity: 1,
          autoplay: false,
          loop: false,
          onEnd: 'freeze',
          muted: true,
          volume: 1,
        },
        width: 320,
        height: 240,
        order: 1,
        visible: false,
      }),
      composeLayer('l3', 'l1', 'Message', 'text', {
        config: {
          content: '${displayName}',
          fontSize: 40,
          color: '#ffffff',
          weight: 700,
          align: 'center',
          allowHtml: false,
          opacity: 1,
        },
        x: 0,
        y: 250,
        width: 320,
        height: 100,
        order: 2,
      }),
      composeLayer('l4', 'l1', 'Sound', 'audio', {
        config: { autoplay: false, loop: false, muted: false, volume: 1 },
        width: 10,
        height: 10,
        order: 3,
        visible: false,
      }),
    ],
    {
      trackClips: [
        trackClip(
          'tc1',
          'compose_layer',
          'l1',
          'Alert Fade',
          4.5,
          'override',
          false,
          false,
          [
            lane('ln1', 'compose_layer', 'l1', 'opacity', [
              kf('k1', 0, 0),
              kf('k2', 0.5, 1),
              kf('k3', 4, 1),
              kf('k4', 4.5, 0),
            ]),
          ],
          [clipEvent('ev1', 0, 'restart', 'compose_layer', 'l4')]
        ),
      ],
      logic: [
        graph(
          'g1',
          'compose_layer',
          'l1',
          'Alert Queue',
          [
            gnode(
              'ev',
              ALERT_TRIGGER_SPECS[INITIAL_TRIGGER].kind,
              0,
              0,
              ALERT_TRIGGER_SPECS[INITIAL_TRIGGER].defaultConfig
            ),
            gnode('fmt', 'text_format', 1, 1, {
              template: '${displayName}',
              fields: ['payload'],
            }),
            gnode('pack', 'pack_event', 2, 0, { fields: ['text'] }),
            gnode('queue', 'queue_events', 3, 0),
            gnode('clock', 'clock', 3, 1, { hz: 0.2 }),
            gnode('unpack', 'unpack_event', 4, 0),
            gnode('setText', 'set_text', 5, 0, {
              targetKind: 'compose_layer',
              targetId: ref('l3'),
            }),
            gnode('play', 'start_clip', 5, 1, { clipId: ref('tc1') }),
          ],
          [
            ...alertTriggerEdges(INITIAL_TRIGGER).map((e) =>
              edge(e.fromNodeId, e.fromPort, e.toNodeId, e.toPort, e.kind!)
            ),
            edge('fmt', 'text', 'pack', 'text', 'value'),
            edge('pack', 'event', 'queue', 'enqueue', 'event'),
            edge('clock', 'tick', 'queue', 'pop', 'event'),
            edge('queue', 'popped', 'unpack', 'event', 'event'),
            edge('unpack', 'trigger', 'setText', 'fire', 'event'),
            edge('unpack', 'trigger', 'play', 'fire', 'event'),
            edge('unpack', 'text', 'setText', 'text', 'value'),
          ]
        ),
      ],
    }
  ),
  composite: 'alert',
};

// ── Chat overlays ─────────────────────────────────────────────────────────
// The chat presets' feed + graph, with the look declared as CSS custom
// properties on `.chat` so the composite's settings can address them.

const chatCss = (size: string) =>
  `.chat { --chat-font: system-ui, sans-serif; --chat-size: ${size}; --chat-color: #ffffff; --chat-bubble: #0000008c; display:flex; flex-direction:column; justify-content:flex-end; height:100%; gap:6px; padding:12px; box-sizing:border-box; overflow:hidden; font-family:var(--chat-font); font-size:var(--chat-size); }
.msg { background:var(--chat-bubble); border-radius:8px; padding:6px 10px; color:var(--chat-color); line-height:1.35; animation:pop .25s ease-out; }
.msg .name { font-weight:700; }
.msg img { height:1.3em; vertical-align:-.25em; }
@keyframes pop { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }`;

const chatFeedGraph = (
  ownerKind: 'compose_layer' | 'scene_node',
  owner: string,
  maxLength: number
) =>
  graph(
    'g1',
    ownerKind,
    owner,
    'Chat Feed',
    [
      gnode('feed', 'overlive_chat_feed', 0, 0, { account: '', maxLength }),
      gnode('sd', 'set_data', 1, 0, { fields: ['chat'], scope: ref(owner) }),
    ],
    [
      edge('feed', 'update', 'sd', 'fire', 'event'),
      edge('feed', 'messages', 'sd', 'chat', 'value'),
    ]
  );

const chatOverlay: BuiltinComposite = {
  ...composeLayerPreset(
    'builtin:composite-chat-overlay',
    'Chat Overlay',
    'Recent chat messages from an Overlive account, as a 2D overlay.',
    [
      composeLayer('l1', null, 'Chat Overlay', 'feed', {
        config: {
          template: FEED_CHAT_TEMPLATE,
          css: chatCss('16px'),
          composite: marker('chat_overlay', { panel: 'l1', feed: 'g1' }),
        },
        x: 24,
        y: 24,
        width: 380,
        height: 480,
        anchorH: 'left',
        anchorV: 'bottom',
      }),
    ],
    { logic: [chatFeedGraph('compose_layer', 'l1', 50)] }
  ),
  composite: 'chat_overlay',
};

const chatOverlay3d: BuiltinComposite = {
  ...sceneNodePreset(
    'builtin:composite-chat-overlay-3d',
    'Chat Overlay (3D)',
    'Recent chat messages from an Overlive account, on a panel in the scene.',
    [
      sceneNode(
        'n1',
        null,
        'Chat Overlay 3D',
        'feed',
        {
          transform: transform(0, 1.5, 0),
          feed: {
            template: FEED_CHAT_TEMPLATE,
            css: chatCss('28px'),
            width: 2,
            height: 2.4,
            padding: 16,
            fontSize: 28,
            color: '#ffffff',
            billboard: true,
          },
        },
        {
          properties: {
            composite: marker('chat_overlay_3d', { panel: 'n1', feed: 'g1' }),
          },
        }
      ),
    ],
    { logic: [chatFeedGraph('scene_node', 'n1', 24)] }
  ),
  composite: 'chat_overlay_3d',
};

// Each chat message spawns a copy of the hidden message template and plays a
// clip sweeping it right → left at a random height and depth.
const scrollingChat: BuiltinComposite = {
  ...sceneNodePreset(
    'builtin:composite-scrolling-chat',
    'Scrolling Chat (3D)',
    'Chat messages fly across the scene from right to left at a random height and depth.',
    [
      sceneNode(
        'n1',
        null,
        'Scrolling Chat',
        'group',
        { transform: transform(0, 0, 0) },
        {
          properties: {
            composite: marker('scrolling_chat', {
              message: 'n2',
              scroll: 'tc1',
              flow: 'g1',
            }),
          },
        }
      ),
      sceneNode(
        'n2',
        'n1',
        'Message Template',
        'text_canvas',
        {
          transform: transform(0, 0, 0),
          text: {
            content: '',
            fontSize: 48,
            color: '#ffffff',
            width: 3,
            height: 0.6,
            billboard: true,
            allowHtml: true,
          },
        },
        { hidden: true }
      ),
    ],
    {
      trackClips: [
        trackClip(
          'tc1',
          'scene_node',
          'n2',
          'Scroll',
          6,
          'override',
          false,
          false,
          [
            lane('ln1', 'scene_node', 'n2', 'position.x', [
              kf('k1', 0, 4),
              kf('k2', 6, -4),
            ]),
          ]
        ),
      ],
      logic: [
        graph(
          'g1',
          'scene_node',
          'n1',
          'Chat → Flying Message',
          [
            gnode('chat', 'overlive_chat_message', 0, 0, { account: '' }),
            gnode('ry', 'random', 1, 0, { min: 0.6, max: 2.4, mode: 'float' }),
            gnode('rz', 'random', 2, 0, { min: -1.2, max: 1.2, mode: 'float' }),
            gnode('spawn', 'spawn_clip', 3, 0, { clipId: ref('tc1') }),
            gnode('setText', 'set_text', 4, 0, { targetKind: 'scene_node' }),
            gnode('setY', 'set_scene_node_param', 4, 1, {
              paramPath: 'position.y',
            }),
            gnode('setZ', 'set_scene_node_param', 4, 2, {
              paramPath: 'position.z',
            }),
          ],
          [
            edge('chat', 'event', 'ry', 'fire', 'event'),
            edge('ry', 'fire', 'rz', 'fire', 'event'),
            edge('rz', 'fire', 'spawn', 'fire', 'event'),
            edge('spawn', 'spawned', 'setText', 'spawnRef', 'event'),
            edge('spawn', 'spawned', 'setY', 'spawnRef', 'event'),
            edge('spawn', 'spawned', 'setZ', 'spawnRef', 'event'),
            edge('chat', 'html', 'setText', 'text', 'value'),
            edge('ry', 'value', 'setY', 'value', 'value'),
            edge('rz', 'value', 'setZ', 'value', 'value'),
          ]
        ),
      ],
    }
  ),
  composite: 'scrolling_chat',
};


// ── Stream widgets (dev-notes/plans/stream-widgets.md) ────────────────────
// Each is one feed layer — the root, playing `panel` — with a graph that
// publishes its data via `set_data`. The look is CSS custom properties
// (--w-*) the shared settings address.

const E = (e: GraphEdgeDescriptor) =>
  edge(e.fromNodeId, e.fromPort, e.toNodeId, e.toPort, e.kind!);

const widgetCss = (root: string, size: string, rest: string) =>
  `.${root} { --w-font: system-ui, sans-serif; --w-size: ${size}; --w-color: #ffffff; --w-accent: #9146ff; --w-track: #00000099; height:100%; box-sizing:border-box; padding:8px; font-family:var(--w-font); font-size:var(--w-size); color:var(--w-color); }
${rest}`;

/** A widget's root feed layer. */
const widgetLayer = (
  name: string,
  type: string,
  graphRole: string,
  template: string,
  css: string,
  box: { x: number; y: number; width: number; height: number }
) =>
  composeLayer('l1', null, name, 'feed', {
    config: {
      template,
      css,
      composite: marker(type, { panel: 'l1', [graphRole]: 'g1' }),
    },
    ...box,
    anchorH: 'left',
    anchorV: 'top',
  });

const TIMER_TEMPLATE = (cls: string) => `<div className="${cls}">
  \${title ? html\`<div className="title">\${title}</div>\` : null}
  <\${Countdown} state=\${timer} className="clock" />
</div>`;

const timerCss = (cls: string) =>
  widgetCss(
    cls,
    '48px',
    `.${cls} { display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; }
.${cls} .title { font-size:.45em; font-weight:700; opacity:.85; }
.${cls} .clock { font-weight:800; font-variant-numeric:tabular-nums; }`
  );

/** Start / pause / resume / reset by named triggers `<base> start` etc. */
const timerTriggers = (base: string, col: number) => [
  gnode('tStart', 'on_trigger', col, 0, { name: `${base} start` }),
  gnode('tPause', 'on_trigger', col, 1, { name: `${base} pause` }),
  gnode('tResume', 'on_trigger', col, 2, { name: `${base} resume` }),
  gnode('tReset', 'on_trigger', col, 3, { name: `${base} reset` }),
];
const timerTriggerEdges = [
  edge('tStart', 'event', 'dl', 'start', 'event'),
  edge('tPause', 'event', 'dl', 'pause', 'event'),
  edge('tResume', 'event', 'dl', 'resume', 'event'),
  edge('tReset', 'event', 'dl', 'reset', 'event'),
];

const srcNode = (id: string, src: EventSource, col: number, row: number) =>
  gnode(id, EVENT_SOURCE_SPECS[src].kind, col, row, {
    ...EVENT_SOURCE_SPECS[src].defaultConfig,
  });

// ── Goal ──

const GOAL_TEMPLATE = `<div className="goal">
  <div className="label">\${label}</div>
  <div className="track"><div className="bar" style=\${{ width: Math.min(100, Math.max(0, target > 0 ? ((current || 0) / target) * 100 : 0)) + '%' }}></div></div>
  <div className="count">\${current || 0} / \${target || 0}</div>
</div>`;

const goal: BuiltinComposite = {
  ...composeLayerPreset(
    'builtin:composite-goal',
    'Goal',
    'A goal bar: the channel’s Twitch goal, or your own goal counted from an event, set by hand, or changed by any other logic.',
    [
      widgetLayer(
        'Goal',
        'goal',
        'flow',
        GOAL_TEMPLATE,
        widgetCss(
          'goal',
          '22px',
          `.goal { display:flex; flex-direction:column; gap:6px; }
.goal .label { font-weight:700; }
.goal .track { flex:1; min-height:20px; background:var(--w-track); border-radius:999px; overflow:hidden; }
.goal .bar { height:100%; background:var(--w-accent); transition:width .6s ease; }
.goal .count { text-align:right; font-variant-numeric:tabular-nums; }`
        ),
        { x: 24, y: 24, width: 420, height: 110 }
      ),
    ],
    {
      logic: [
        graph(
          'g1',
          'compose_layer',
          'l1',
          'Goal',
          [
            gnode('goal', 'overlive_goal', 0, 0, { account: '', kind: '' }),
            srcNode('src', 'follow', 0, 1),
            gnode('inc', 'increment_variable', 1, 1, {
              name: 'goal',
              persistent: true,
            }),
            gnode('online', 'overlive_stream_online', 0, 2, { account: '' }),
            gnode('zero', 'set_variable', 1, 2, {
              name: 'goal',
              value: 0,
              persistent: true,
            }),
            gnode('get', 'variable', 2, 1, { name: 'goal' }),
            gnode('sd', 'set_data', 3, 0, {
              fields: ['current', 'target', 'label'],
              scope: ref('l1'),
              target: 50,
              label: 'Follower goal',
            }),
          ],
          [
            edge('get', 'changed', 'sd', 'fire', 'event'),
            edge('get', 'value', 'sd', 'current', 'value'),
            ...goalCountEdges('follow').map(E),
            ...GOAL_RESET_EDGES.map(E),
          ]
        ),
      ],
    }
  ),
  composite: 'goal',
};

// ── Countdown ──

const countdown: BuiltinComposite = {
  ...composeLayerPreset(
    'builtin:composite-countdown',
    'Countdown',
    'A countdown for a set time or to a time of day. Start, pause and reset it from its settings or with named triggers; it can send a trigger when it runs out.',
    [
      widgetLayer(
        'Countdown',
        'countdown',
        'timer',
        TIMER_TEMPLATE('countdown'),
        timerCss('countdown'),
        { x: 24, y: 24, width: 360, height: 150 }
      ),
    ],
    {
      logic: [
        graph(
          'g1',
          'compose_layer',
          'l1',
          'Countdown',
          [
            gnode('lid', 'logic_id', 1, 4),
            ...timerTriggers('countdown', 0),
            gnode('dt', 'date_time', 1, 5, { text: '20:00' }),
            gnode('dl', 'deadline', 2, 1, {
              name: 'countdown',
              persistent: true,
              duration: 300,
            }),
            gnode('sd', 'set_data', 3, 0, {
              fields: ['timer', 'title'],
              scope: ref('l1'),
              title: 'Starting soon',
            }),
            gnode('done', 'send_trigger', 3, 2, { name: '' }),
          ],
          [
            edge('lid', 'id', 'dl', 'scope', 'value'),
            ...timerTriggerEdges,
            edge('dl', 'changed', 'sd', 'fire', 'event'),
            edge('dl', 'state', 'sd', 'timer', 'value'),
            edge('dl', 'finished', 'done', 'fire', 'event'),
          ]
        ),
      ],
    }
  ),
  composite: 'countdown',
};

// ── Subathon ──

const SUBATHON_RATES: { src: EventSource; m: string; p: string; s: string; b: number; amount: boolean }[] = [
  { src: 'sub', s: 'sSub', m: 'mSub', p: 'pSub', b: 300, amount: false },
  { src: 'gift', s: 'sGift', m: 'mGift', p: 'pGift', b: 300, amount: true },
  { src: 'bits', s: 'sBits', m: 'mBits', p: 'pBits', b: 0.6, amount: true },
  { src: 'tip', s: 'sTip', m: 'mTip', p: 'pTip', b: 60, amount: true },
  { src: 'follow', s: 'sFollow', m: 'mFollow', p: 'pFollow', b: 0, amount: false },
];

const subathon: BuiltinComposite = {
  ...composeLayerPreset(
    'builtin:composite-subathon',
    'Subathon Timer',
    'A subathon timer: subs, gifts, bits, tips and follows add time at your rates, with soft-limit stages and a hard cap. Start and pause it from its settings or with named triggers.',
    [
      widgetLayer(
        'Subathon',
        'subathon',
        'flow',
        TIMER_TEMPLATE('subathon'),
        timerCss('subathon'),
        { x: 24, y: 24, width: 380, height: 150 }
      ),
    ],
    {
      logic: [
        graph(
          'g1',
          'compose_layer',
          'l1',
          'Subathon',
          [
            ...SUBATHON_RATES.flatMap((r, i) => [
              srcNode(r.s, r.src, 0, i),
              gnode(r.m, 'math', 1, i, {
                op: 'multiply',
                ...(r.amount ? {} : { a: 1 }),
                b: r.b,
              }),
              gnode(r.p, 'pack_event', 2, i, { fields: ['by'] }),
            ]),
            gnode('un', 'unpack_event', 3, 0),
            gnode('st', 'step_lookup', 3, 2, {
              steps: [],
              below: 1,
              plannedStart: '',
            }),
            gnode('mf', 'math', 4, 1, { op: 'multiply' }),
            gnode('cap', 'math', 4, 3, { op: 'subtract', a: NO_CAP }),
            gnode('cl', 'clamp', 5, 1, { min: 0 }),
            gnode('lid', 'logic_id', 5, 4),
            ...timerTriggers('subathon', 5).map((n) => ({
              ...n,
              position: { x: n.position.x, y: n.position.y + 800 },
            })),
            gnode('dl', 'deadline', 6, 1, {
              name: 'subathon',
              persistent: true,
              duration: 3600,
            }),
            gnode('sd', 'set_data', 7, 0, {
              fields: ['timer', 'title'],
              scope: ref('l1'),
              title: 'Subathon',
            }),
          ],
          [
            ...SUBATHON_RATES.flatMap((r) => [
              edge(r.s, 'event', r.p, 'fire', 'event'),
              ...(r.amount
                ? [edge(r.s, EVENT_SOURCE_SPECS[r.src].amount!, r.m, 'a', 'value')]
                : []),
              edge(r.m, 'value', r.p, 'by', 'value'),
              edge(r.p, 'event', 'un', 'event', 'event'),
            ]),
            edge('dl', 'total', 'st', 'x', 'value'),
            edge('un', 'by', 'mf', 'a', 'value'),
            edge('st', 'value', 'mf', 'b', 'value'),
            edge('dl', 'total', 'cap', 'b', 'value'),
            edge('mf', 'value', 'cl', 'value', 'value'),
            edge('cap', 'value', 'cl', 'max', 'value'),
            edge('cl', 'value', 'dl', 'by', 'value'),
            edge('un', 'trigger', 'dl', 'add', 'event'),
            edge('lid', 'id', 'dl', 'scope', 'value'),
            ...timerTriggerEdges,
            edge('dl', 'changed', 'sd', 'fire', 'event'),
            edge('dl', 'state', 'sd', 'timer', 'value'),
          ]
        ),
      ],
    }
  ),
  composite: 'subathon',
};

// ── Recent events ──

const RECENT_LABELS: Record<string, string> = {
  follow: 'followed',
  sub: 'subscribed',
  gift: 'gifted subs:',
  bits: 'cheered',
  tip: 'tipped',
  raid: 'raided with',
};

const RECENT_TEMPLATE = `<div className="events">
  \${(recent || []).map((e) => html\`<div className="row" key=\${e.at + ':' + e.name}><span className="name">\${e.name}</span> <span className="what">\${e.label}\${e.amount !== 1 ? ' ' + Math.round(e.amount * 100) / 100 : ''}</span></div>\`)}
</div>`;

const listCss = (cls: string, rest = '') =>
  widgetCss(
    cls,
    '20px',
    `.${cls} { display:flex; flex-direction:column; gap:6px; overflow:hidden; }
.${cls} .title { font-weight:800; }
.${cls} .row { background:#0000008c; border-radius:8px; padding:6px 10px; animation:pop .25s ease-out; }
.${cls} .name { font-weight:700; color:var(--w-accent); }
${rest}@keyframes pop { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }`
  );

const recentEvents: BuiltinComposite = {
  ...composeLayerPreset(
    'builtin:composite-recent-events',
    'Recent Events',
    'The latest follows, subs, gifts, bits, tips and raids, newest first — for this stream or kept across streams.',
    [
      widgetLayer(
        'Recent Events',
        'recent_events',
        'flow',
        RECENT_TEMPLATE,
        listCss('events'),
        { x: 24, y: 24, width: 360, height: 280 }
      ),
    ],
    {
      logic: [
        graph(
          'g1',
          'compose_layer',
          'l1',
          'Recent Events',
          [
            ...RECENT_SOURCES.flatMap((src, i) => {
              const { node, pack } = recentIds(src);
              return [
                srcNode(node, src, 0, i),
                gnode(pack, 'pack_event', 1, i, {
                  fields: ['user', 'amount', 'label'],
                  label: RECENT_LABELS[src],
                  amount: 1,
                }),
              ];
            }),
            gnode('un', 'unpack_event', 2, 0),
            gnode('online', 'overlive_stream_online', 2, 3, { account: '' }),
            gnode('lid', 'logic_id', 2, 4),
            gnode('tl', 'tally', 3, 0, {
              name: 'recent',
              persistent: true,
              keep: 5,
            }),
            gnode('sd', 'set_data', 4, 0, {
              fields: ['recent'],
              scope: ref('l1'),
            }),
          ],
          [
            ...RECENT_SOURCES.flatMap((src) => {
              const { node, pack } = recentIds(src);
              const spec = EVENT_SOURCE_SPECS[src];
              return [
                edge(node, 'event', pack, 'fire', 'event'),
                edge(node, spec.user!, pack, 'user', 'value'),
                ...(spec.amount ? [edge(node, spec.amount, pack, 'amount', 'value')] : []),
                edge(pack, 'event', 'un', 'event', 'event'),
              ];
            }),
            edge('un', 'trigger', 'tl', 'add', 'event'),
            edge('un', 'user', 'tl', 'user', 'value'),
            edge('un', 'amount', 'tl', 'amount', 'value'),
            edge('un', 'label', 'tl', 'label', 'value'),
            edge('lid', 'id', 'tl', 'scope', 'value'),
            ...RECENT_RESET_EDGES.map(E),
            edge('tl', 'changed', 'sd', 'fire', 'event'),
            edge('tl', 'recent', 'sd', 'recent', 'value'),
          ]
        ),
      ],
    }
  ),
  composite: 'recent_events',
};

// ── Top supporters ──

const TOP_TEMPLATE = `<div className="top">
  \${title ? html\`<div className="title">\${title}</div>\` : null}
  \${(top || []).map((e, i) => html\`<div className="row" key=\${e.name}><span className="rank">\${i + 1}.</span> <span className="name">\${e.name}</span> <span className="amount">\${Math.round(e.total * 100) / 100}</span></div>\`)}
</div>`;

const topSupporters: BuiltinComposite = {
  ...composeLayerPreset(
    'builtin:composite-top-supporters',
    'Top Supporters',
    'A leaderboard of who gave the most bits, tips, gifted subs, subs or raid viewers — for this stream or across streams.',
    [
      widgetLayer(
        'Top Supporters',
        'top_supporters',
        'flow',
        TOP_TEMPLATE,
        listCss('top', `.top .row { display:flex; gap:8px; }
.top .amount { margin-left:auto; font-variant-numeric:tabular-nums; }
`),
        { x: 24, y: 24, width: 320, height: 280 }
      ),
    ],
    {
      logic: [
        graph(
          'g1',
          'compose_layer',
          'l1',
          'Top Supporters',
          [
            srcNode('src', 'bits', 0, 0),
            gnode('online', 'overlive_stream_online', 0, 2, { account: '' }),
            gnode('lid', 'logic_id', 0, 3),
            gnode('tl', 'tally', 1, 0, {
              name: 'top',
              persistent: true,
              topCount: 5,
            }),
            gnode('sd', 'set_data', 2, 0, {
              fields: ['top', 'title'],
              scope: ref('l1'),
              title: 'Top supporters',
            }),
          ],
          [
            ...topEdges('bits').map(E),
            edge('lid', 'id', 'tl', 'scope', 'value'),
            ...RECENT_RESET_EDGES.map(E),
            edge('tl', 'changed', 'sd', 'fire', 'event'),
            edge('tl', 'top', 'sd', 'top', 'value'),
          ]
        ),
      ],
    }
  ),
  composite: 'top_supporters',
};

// ── Ad break ──

const AD_TEMPLATE = `\${timer && timer.running ? html\`<div className="ad">
  <div className="message">\${message}</div>
  <\${Countdown} state=\${timer} className="clock" />
</div>\` : null}`;

const adBreak: BuiltinComposite = {
  ...composeLayerPreset(
    'builtin:composite-ad-break',
    'Ad Break',
    'Shown while an ad break runs, with the time until it ends.',
    [
      widgetLayer(
        'Ad Break',
        'ad_break',
        'flow',
        AD_TEMPLATE,
        widgetCss(
          'ad',
          '32px',
          `.ad { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; background:#000000b3; border-radius:12px; border:2px solid var(--w-accent); }
.ad .clock { font-weight:800; font-variant-numeric:tabular-nums; }`
        ),
        { x: 660, y: 40, width: 600, height: 140 }
      ),
    ],
    {
      logic: [
        graph(
          'g1',
          'compose_layer',
          'l1',
          'Ad Break',
          [
            gnode('ad', 'overlive_ad_start', 0, 0, { account: '' }),
            gnode('end', 'overlive_ad_end', 0, 1, { account: '' }),
            gnode('lid', 'logic_id', 0, 2),
            gnode('dl', 'deadline', 1, 0, { name: 'ad', persistent: false }),
            gnode('sd', 'set_data', 2, 0, {
              fields: ['timer', 'message'],
              scope: ref('l1'),
              message: 'Ad break — back in',
            }),
          ],
          [
            edge('ad', 'event', 'dl', 'start', 'event'),
            edge('ad', 'durationSeconds', 'dl', 'duration', 'value'),
            edge('end', 'event', 'dl', 'reset', 'event'),
            edge('lid', 'id', 'dl', 'scope', 'value'),
            edge('dl', 'changed', 'sd', 'fire', 'event'),
            edge('dl', 'state', 'sd', 'timer', 'value'),
          ]
        ),
      ],
    }
  ),
  composite: 'ad_break',
};

export const BUILTIN_COMPOSITES: BuiltinComposite[] = [
  alert,
  chatOverlay,
  chatOverlay3d,
  scrollingChat,
  goal,
  countdown,
  subathon,
  recentEvents,
  topSupporters,
  adBreak,
];
