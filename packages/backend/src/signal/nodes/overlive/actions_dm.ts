import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, eventOut } from '@vspark/shared/node_decorators';
import { getOverliveManager } from '../../../overlive/manager.js';
import { acct, strOf } from './_actions.js';

/**
 * Send a whisper (DM) to a user on `fire`. Requires `user:manage:whispers`.
 * NOTE: Twitch requires the app to have a verified phone number and heavily
 * rate-limits whispers, so this can fail even with the scope present — errors
 * are logged and swallowed like every other action.
 */
@SignalNode({
  label: 'Overlive Whisper',
  description: 'Sends a whisper (DM) to a user on fire. Twitch rate-limits whispers and needs a phone-verified app.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveWhisper extends Node {
  static readonly kind = 'overlive_whisper';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('userId', 'String') userId!: () => string | undefined;
  @valueIn('message', 'String') message!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const cfg = (this.config ?? {}) as { userId?: string; message?: string };
    const userId = strOf(this.userId, cfg.userId);
    const message = strOf(this.message, cfg.message);
    if (!userId || !message) return;
    void getOverliveManager().sendWhisper(accountId, userId, message);
    this.done.emit(undefined);
  }
}
