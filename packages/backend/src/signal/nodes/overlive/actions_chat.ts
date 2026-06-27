import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, eventOut } from '@vspark/shared/node_decorators';
import { getOverliveManager } from '../../../overlive/manager.js';
import { acct } from './_actions.js';

/**
 * Post a highlighted announcement to chat on `fire`. Requires the
 * `moderator:manage:announcements` scope. `color` is one of blue/green/orange/
 * purple/primary (anything else → primary).
 */
@SignalNode({
  label: 'Overlive Announce',
  description: 'Posts a highlighted chat announcement on fire (color: blue/green/orange/purple/primary).',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveAnnounce extends Node {
  static readonly kind = 'overlive_announce';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('message', 'String') message!: () => string | undefined;
  @valueIn('color', 'String') color!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const cfg = (this.config ?? {}) as { message?: string; color?: string };
    const message = this.message() ?? cfg.message ?? '';
    const color = this.color() ?? cfg.color;
    void getOverliveManager().sendAnnouncement(accountId, message, color);
    this.done.emit(undefined);
  }
}

/**
 * Give another channel a shoutout on `fire`. `target` is the recipient's
 * broadcaster user id. Requires `moderator:manage:shoutouts`.
 */
@SignalNode({
  label: 'Overlive Shoutout',
  description: 'Sends a shoutout to another channel (target = broadcaster user id) on fire.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveShoutout extends Node {
  static readonly kind = 'overlive_shoutout';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('target', 'String') target!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const cfg = (this.config ?? {}) as { target?: string };
    const target = this.target() ?? cfg.target ?? '';
    if (!target) return;
    void getOverliveManager().sendShoutout(accountId, target);
    this.done.emit(undefined);
  }
}

/**
 * Set the broadcaster's own chat name color on `fire`. Named color or `#hex`
 * (hex requires Turbo/Prime). Requires `user:manage:chat_color`.
 */
@SignalNode({
  label: 'Overlive Chat Color',
  description: "Sets the broadcaster's chat name color on fire (named or #hex).",
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveChatColor extends Node {
  static readonly kind = 'overlive_chat_color';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('color', 'String') color!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const cfg = (this.config ?? {}) as { color?: string };
    const color = this.color() ?? cfg.color ?? '';
    if (!color) return;
    void getOverliveManager().updateChatColor(accountId, color);
    this.done.emit(undefined);
  }
}
