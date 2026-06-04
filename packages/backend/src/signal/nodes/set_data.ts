import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { dataChannelManager } from '../../data_channels/manager.js';

interface SetDataConfig {
  channel?: string;
}

/**
 * Generic sibling of `set_text`: publishes an arbitrary payload to a NAMED
 * data channel on the data-channel bus. The frontend `feed` compose layer
 * subscribes to the channel and renders the payload through a
 * data-shape-independent template.
 *
 * The `data` input is `Any` (inferred from whatever is wired in) — it can be a
 * record (`pack_event`), a list (`overlive_chat_feed.messages`), or any scalar.
 * Whole-payload republish per fire (no diffing); see DataChannelManager.
 */
@SignalNode({
  label: 'Set Data',
  description:
    'Publishes the wired payload to a named data channel for the frontend feed/template layer.',
  tags: ['output', 'compose'],
  color: '#3a7a5a',
})
export class SetData extends Node {
  static readonly kind = 'set_data';

  @valueIn('channel', 'String') channel!: () => string | undefined;
  @valueIn('data', 'Any') data!: () => unknown;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const cfg = (this.config ?? {}) as SetDataConfig;
    const channel = this.channel() || cfg.channel || '';
    if (!channel) return;
    dataChannelManager.set(channel, this.data() ?? null);
  }
}
