// Built-in event-alert overlay presets (Donations / Tips / Subs / Raids).
//
// Each is a compose `group` holding an `image` badge + a `text` caption, both
// starting at opacity 0 (invisible at rest). On the matching Overlive event the
// graph packs the relevant field, FIFO-queues it, and releases one alert per
// clock tick (so bursts don't overlap): it sets the caption text and plays a
// track clip that fades both children in and back out. When the clip finishes
// the override is cleared and the overlay returns to opacity 0.
//
// To use: drop in an image for the badge, and set the `account` on the
// overlive_* node in the graph. Tune the clock hz / clip duration to taste.
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
}

function alertPreset(spec: AlertSpec): BuiltinPreset {
  return composeLayerPreset(
    spec.id,
    spec.name,
    spec.description,
    [
      composeLayer('l1', null, spec.name, 'group', { sceneOrder: -1 }),
      composeLayer('l2', 'l1', 'Badge', 'image', {
        config: { objectFit: 'contain', opacity: 0 },
        x: 40,
        y: 40,
        width: 120,
        height: 120,
        anchorH: 'left',
        anchorV: 'top',
        sceneOrder: -1,
      }),
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
        anchorH: 'left',
        anchorV: 'top',
        sceneOrder: -1,
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
        graph(
          'g1',
          'compose_layer',
          'l1',
          `${spec.name} Queue`,
          [
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
          ],
          [
            edge('ev', 'event', 'pack', 'fire', 'event'),
            edge('ev', spec.textPort, 'pack', 'text', 'value'),
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
  );
}

export const ALERT_PRESETS: BuiltinPreset[] = [
  alertPreset({
    id: 'builtin:alert-donation',
    name: 'Donation Alert',
    description:
      'Queued donation overlay: badge + donor name fade in/out. Wire to a channel-points / currency reward via overlive_redemption.',
    eventKind: 'overlive_redemption',
    textPort: 'displayName',
    caption: 'Donation',
    eventConfig: { account: '', currencyKind: '', rewardId: '' },
  }),
  alertPreset({
    id: 'builtin:alert-tip',
    name: 'Tip Alert',
    description:
      'Queued tip overlay: badge + tipper name fade in/out. Wire to your tip currency via overlive_redemption.',
    eventKind: 'overlive_redemption',
    textPort: 'displayName',
    caption: 'Tip',
    eventConfig: { account: '', currencyKind: '', rewardId: '' },
  }),
  alertPreset({
    id: 'builtin:alert-sub',
    name: 'Sub Alert',
    description:
      'Queued subscription overlay: badge + subscriber name fade in/out via overlive_subscription.',
    eventKind: 'overlive_subscription',
    textPort: 'displayName',
    caption: 'New Subscriber',
    eventConfig: { account: '', tier: '', isGift: '' },
  }),
  alertPreset({
    id: 'builtin:alert-raid',
    name: 'Raid Alert',
    description:
      'Queued raid overlay: badge + raider name fade in/out via overlive_raid.',
    eventKind: 'overlive_raid',
    textPort: 'fromDisplayName',
    caption: 'Raid',
    eventConfig: { account: '' },
  }),
];
