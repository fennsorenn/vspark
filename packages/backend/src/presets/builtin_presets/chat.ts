// Built-in chat-overlay presets.
//
// All three rely on Overlive: open the bundled graph and set the `account` on
// the overlive_* node to one of your connected accounts (TopBar > Overlive
// Accounts). Until an account is set the overlay renders but stays empty.
import {
  composeLayer,
  composeLayerPreset,
  edge,
  FEED_CHAT_CSS,
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

// ── 1. Chat overlay — 2D compose `feed` layer ─────────────────────────────
// A feed layer reads the data channel by identity (global ∪ its own id). The
// owned graph publishes recent chat to the layer's own scope via set_data.
const chatOverlayLayer = composeLayerPreset(
  'builtin:chat-overlay-layer',
  'Chat Overlay (Layer)',
  'A 2D chat overlay layer fed by an Overlive account. Set the account on the overlive_chat_feed node in this layer’s graph.',
  [
    composeLayer('l1', null, 'Chat Overlay', 'feed', {
      config: { template: FEED_CHAT_TEMPLATE, css: FEED_CHAT_CSS },
      x: 24,
      y: 24,
      width: 380,
      height: 480,
      anchorH: 'left',
      anchorV: 'bottom',
      sceneOrder: -1,
    }),
  ],
  {
    graphs: [
      graph(
        'g1',
        'compose_layer',
        'l1',
        'Chat Feed',
        [
          gnode('feed', 'overlive_chat_feed', 0, 0, {
            account: '',
            maxLength: 50,
          }),
          gnode('sd', 'set_data', 1, 0, {
            fields: ['chat'],
            scope: ref('l1'),
          }),
        ],
        [
          edge('feed', 'update', 'sd', 'fire', 'event'),
          edge('feed', 'messages', 'sd', 'chat', 'value'),
        ]
      ),
    ],
  }
);

// ── 2. Chat overlay — 3D `feed` scene node ────────────────────────────────
const chatOverlay3d = sceneNodePreset(
  'builtin:chat-overlay-3d',
  'Chat Overlay (3D)',
  'An in-scene 3D chat panel fed by an Overlive account. Set the account on the overlive_chat_feed node in this node’s graph.',
  [
    sceneNode('n1', null, 'Chat Overlay 3D', 'feed', {
      transform: transform(0, 1.5, 0),
      feed: {
        template: FEED_CHAT_TEMPLATE,
        css: FEED_CHAT_CSS,
        width: 2,
        height: 2.4,
        padding: 16,
        fontSize: 28,
        color: '#ffffff',
        billboard: true,
      },
    }),
  ],
  {
    graphs: [
      graph(
        'g1',
        'scene_node',
        'n1',
        'Chat Feed',
        [
          gnode('feed', 'overlive_chat_feed', 0, 0, {
            account: '',
            maxLength: 24,
          }),
          gnode('sd', 'set_data', 1, 0, {
            fields: ['chat'],
            scope: ref('n1'),
          }),
        ],
        [
          edge('feed', 'update', 'sd', 'fire', 'event'),
          edge('feed', 'messages', 'sd', 'chat', 'value'),
        ]
      ),
    ],
  }
);

// ── 3. Scrolling chat messages in 3D ──────────────────────────────────────
// Each chat message spawns an ephemeral clone of a hidden text_canvas template
// and plays a clip that sweeps it from the right (+X) to the left (-X). The
// start Y/Z are randomised per spawn via set_scene_node_param (runtime
// overrides on axes the clip doesn't touch, so they coexist with the X sweep).
const scrollingChat3d = sceneNodePreset(
  'builtin:scrolling-chat-3d',
  'Scrolling Chat (3D)',
  'Chat messages fly across the scene from right to left at a random height/depth. Set the account on the overlive_chat_message node in the graph.',
  [
    sceneNode('n1', null, 'Scrolling Chat', 'group', {
      transform: transform(0, 0, 0),
    }),
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
    graphs: [
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
          // `random`'s output event port is also named `fire` (input `fire`,
          // output `fire`); direction disambiguates. Matches the chat-billboard
          // sample wiring.
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
);

export const CHAT_PRESETS: BuiltinPreset[] = [
  chatOverlayLayer,
  chatOverlay3d,
  scrollingChat3d,
];
