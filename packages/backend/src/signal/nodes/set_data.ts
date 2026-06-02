import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { dataChannelManager } from '../../data_channels/manager.js';

interface SetDataConfig {
  channel?: string;
  /** Optional scene id to scope the channel to. When empty the payload is
   *  published to the global bucket (the frontend feed layer falls back to it). */
  scene?: string;
}

/**
 * Generic sibling of `set_text`. Publishes an arbitrary payload to a NAMED data
 * channel via the data-channel bus, which rebroadcasts it over WS to any
 * frontend feed/template layer subscribed to that channel.
 *
 * The `data` input is typed `Any` (inferred via Phase 2), so a chat
 * `List<ChatFeedMessage>`, a `pack_event` record, or any other structured value
 * flows through unchanged — the bus and the renderer are data-shape-agnostic.
 *
 * See dev-notes/modules/data-channels.md.
 */
@SignalNode({
  label: 'Set Data',
  description:
    'Publishes an arbitrary payload to a named data channel for the frontend feed/template layer.',
  tags: ['compose', 'output'],
  color: '#3a7a5a',
})
export class SetData extends Node {
  static readonly kind = 'set_data';

  @valueIn('channel', 'String') channel!: () => string | undefined;
  @valueIn('data', 'Any') data!: () => unknown;
  @valueIn('scene', 'String') scene!: () => string | undefined;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const cfg = (this.config ?? {}) as SetDataConfig;
    const channel = (this.channel() ?? cfg.channel ?? '').trim();
    if (!channel) return;
    const scene = (this.scene() ?? cfg.scene ?? '').trim();
    dataChannelManager.set(scene, channel, this.data());
  }
}
