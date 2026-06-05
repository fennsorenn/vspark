// Built-in event-alert overlay presets (Donations / Tips / Subs / Raids).
//
// Each is a compose `group` holding a visual badge (an `image` or, in the
// `-video` variants, a `video` layer) + a `text` caption — both starting at
// opacity 0 (invisible at rest) — plus a hidden `audio` compose layer that acts
// as the alert's sound source.
//
// On the matching Overlive event the graph packs the relevant field,
// FIFO-queues it, and releases one alert per clock tick (so bursts don't
// overlap): it sets the caption text, plays a track clip that fades the visual
// + caption in and back out, restarts the audio layer (and, for video variants,
// the video), then settles back to opacity 0 when the clip finishes.
//
// To use: drop an audio clip into the Sound layer (and an image / video into
// the badge), then set the `account` on the overlive_* node in the graph. Tune
// the clock hz / clip duration to taste.
import {
  composeLayer,
  composeLayerPreset,
  edge,
  gnode,
  graph,
  kf,
  lane,
  ref,
  trackClip,
  type GEdge,
  type GNode,
  type BuiltinPreset,
} from './helpers.js';

interface AlertSpec {
  id: string;
  name: string;
  description: string;
  /** Overlive event node kind that triggers the alert. */
  eventKind: string;
  /** Output port on the event node whose value becomes the caption text. */
  textPort: string;
  /** Placeholder caption shown before the first event (and if no event field). */
  caption: string;
  /** Per-event-node default config (account + any filters). */
  eventConfig: Record<string, unknown>;
  /** Visual badge kind: a still `image` or a playing `video`. */
  media: 'image' | 'video';
}

function alertPreset(spec: AlertSpec): BuiltinPreset {
  const isVideo = spec.media === 'video';

  // l2 — the visual badge (image or video), faded in/out by the clip.
  const badge = isVideo
    ? composeLayer('l2', 'l1', 'Video', 'video', {
        config: {
          objectFit: 'contain',
          opacity: 0,
          // Command-driven (restart on each alert); muted because the dedicated
          // audio layer carries the sound.
          autoplay: false,
          loop: false,
          onEnd: 'freeze',
          muted: true,
          volume: 1,
        },
        x: 40,
        y: 40,
        width: 160,
        height: 120,
        sceneOrder: -1,
      })
    : composeLayer('l2', 'l1', 'Badge', 'image', {
        config: { objectFit: 'contain', opacity: 0 },
        x: 40,
        y: 40,
        width: 120,
        height: 120,
        sceneOrder: -1,
      });

  // Graph: shared chain + per-media playback commands.
  const nodes: GNode[] = [
    gnode('ev', spec.eventKind, 0, 0, spec.eventConfig),
    gnode('pack', 'pack_event', 1, 0, { fields: ['text'] }),
    gnode('queue', 'queue_events', 2, 0),
    gnode('clock', 'clock', 2, 1, { hz: 0.2 }),
    gnode('unpack', 'unpack_event', 3, 0),
    gnode('setText', 'set_text', 4, 0, {
      targetKind: 'compose_layer',
      targetId: ref('l3'),
    }),
    gnode('play', 'start_clip', 4, 1, { clipId: ref('tc1') }),
    // Restart the bundled audio layer so the alert plays its sound from the top.
    gnode('sound', 'media_control', 4, 2, {
      action: 'restart',
      targetKind: 'compose_layer',
      targetId: ref('l4'),
    }),
  ];
  const edges: GEdge[] = [
    edge('ev', 'event', 'pack', 'fire', 'event'),
    edge('ev', spec.textPort, 'pack', 'text', 'value'),
    edge('pack', 'event', 'queue', 'enqueue', 'event'),
    edge('clock', 'tick', 'queue', 'pop', 'event'),
    edge('queue', 'popped', 'unpack', 'event', 'event'),
    edge('unpack', 'trigger', 'setText', 'fire', 'event'),
    edge('unpack', 'trigger', 'play', 'fire', 'event'),
    edge('unpack', 'trigger', 'sound', 'fire', 'event'),
    edge('unpack', 'text', 'setText', 'text', 'value'),
  ];
  if (isVideo) {
    // Also restart the video so it plays its clip from the start each alert.
    nodes.push(
      gnode('vid', 'media_control', 4, 3, {
        action: 'restart',
        targetKind: 'compose_layer',
        targetId: ref('l2'),
      })
    );
    edges.push(edge('unpack', 'trigger', 'vid', 'fire', 'event'));
  }

  return composeLayerPreset(
    spec.id,
    spec.name,
    spec.description,
    [
      composeLayer('l1', null, spec.name, 'group', { sceneOrder: -1 }),
      badge,
      composeLayer('l3', 'l1', 'Caption', 'text', {
        config: {
          content: spec.caption,
          fontSize: 40,
          color: '#ffffff',
          weight: 700,
          align: 'left',
          allowHtml: false,
          opacity: 0,
        },
        x: 180,
        y: 60,
        width: 440,
        height: 90,
        sceneOrder: -1,
      }),
      // l4 — the sound source. Invisible (visible:false still mounts + plays,
      // since the stack uses visibility:hidden), command-driven (autoplay off).
      composeLayer('l4', 'l1', 'Sound', 'audio', {
        config: { autoplay: false, loop: false, muted: false, volume: 1 },
        width: 10,
        height: 10,
        sceneOrder: -1,
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
            lane('ln1', 'compose_layer', 'l2', 'opacity', [
              kf('k1', 0, 0),
              kf('k2', 0.5, 1),
              kf('k3', 4, 1),
              kf('k4', 4.5, 0),
            ]),
            lane('ln2', 'compose_layer', 'l3', 'opacity', [
              kf('k5', 0, 0),
              kf('k6', 0.5, 1),
              kf('k7', 4, 1),
              kf('k8', 4.5, 0),
            ]),
          ]
        ),
      ],
      graphs: [
        graph('g1', 'compose_layer', 'l1', `${spec.name} Queue`, nodes, edges),
      ],
    }
  );
}

interface AlertBase {
  baseId: string;
  name: string;
  eventKind: string;
  textPort: string;
  caption: string;
  eventConfig: Record<string, unknown>;
  blurb: string;
}

const ALERT_BASES: AlertBase[] = [
  {
    baseId: 'builtin:alert-donation',
    name: 'Donation Alert',
    eventKind: 'overlive_redemption',
    textPort: 'displayName',
    caption: 'Donation',
    eventConfig: { account: '', currencyKind: '', rewardId: '' },
    blurb:
      'Queued donation overlay: badge + donor name fade in/out with a sound. Wire to a channel-points / currency reward via overlive_redemption.',
  },
  {
    baseId: 'builtin:alert-tip',
    name: 'Tip Alert',
    eventKind: 'overlive_redemption',
    textPort: 'displayName',
    caption: 'Tip',
    eventConfig: { account: '', currencyKind: '', rewardId: '' },
    blurb:
      'Queued tip overlay: badge + tipper name fade in/out with a sound. Wire to your tip currency via overlive_redemption.',
  },
  {
    baseId: 'builtin:alert-sub',
    name: 'Sub Alert',
    eventKind: 'overlive_subscription',
    textPort: 'displayName',
    caption: 'New Subscriber',
    eventConfig: { account: '', tier: '', isGift: '' },
    blurb:
      'Queued subscription overlay: badge + subscriber name fade in/out with a sound via overlive_subscription.',
  },
  {
    baseId: 'builtin:alert-raid',
    name: 'Raid Alert',
    eventKind: 'overlive_raid',
    textPort: 'fromDisplayName',
    caption: 'Raid',
    eventConfig: { account: '' },
    blurb:
      'Queued raid overlay: badge + raider name fade in/out with a sound via overlive_raid.',
  },
];

// For each event, ship an image variant and a video variant. Both bundle a
// hidden audio layer as the sound source.
export const ALERT_PRESETS: BuiltinPreset[] = ALERT_BASES.flatMap((b) => [
  alertPreset({
    id: b.baseId,
    name: b.name,
    description: b.blurb,
    eventKind: b.eventKind,
    textPort: b.textPort,
    caption: b.caption,
    eventConfig: b.eventConfig,
    media: 'image',
  }),
  alertPreset({
    id: `${b.baseId}-video`,
    name: `${b.name} (Video)`,
    description: b.blurb.replace('badge +', 'video +'),
    eventKind: b.eventKind,
    textPort: b.textPort,
    caption: b.caption,
    eventConfig: b.eventConfig,
    media: 'video',
  }),
]);
