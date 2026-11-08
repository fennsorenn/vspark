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
  type AlertTrigger,
} from '@vspark/shared/composites';
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
    'An event alert: badge, message and sound fade in on a donation, tip, sub, raid or a named trigger, queued so bursts play one after another.',
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

export const BUILTIN_COMPOSITES: BuiltinComposite[] = [
  alert,
  chatOverlay,
  chatOverlay3d,
  scrollingChat,
];
