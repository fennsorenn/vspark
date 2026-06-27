import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, eventOut } from '@vspark/shared/node_decorators';
import { getOverliveManager } from '../../../overlive/manager.js';
import { acct, strOf, numOf, toggle, durationSetting } from './_actions.js';

/**
 * Ban or timeout a user on `fire`. `seconds` > 0 makes it a timeout; blank/0 is
 * a permanent ban. Requires `moderator:manage:banned_users`.
 */
@SignalNode({
  label: 'Overlive Ban / Timeout',
  description: 'Bans (permanent) or times out (seconds > 0) a user on fire.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveBanUser extends Node {
  static readonly kind = 'overlive_ban_user';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('userId', 'String') userId!: () => string | undefined;
  @valueIn('seconds', 'Float') seconds!: () => number | undefined;
  @valueIn('reason', 'String') reason!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const cfg = (this.config ?? {}) as { userId?: string; seconds?: number; reason?: string };
    const userId = strOf(this.userId, cfg.userId);
    if (!userId) return;
    void getOverliveManager().banUser(accountId, userId, numOf(this.seconds, cfg.seconds), strOf(this.reason, cfg.reason) || undefined);
    this.done.emit(undefined);
  }
}

/** Lift a ban/timeout on `fire`. Requires `moderator:manage:banned_users`. */
@SignalNode({
  label: 'Overlive Unban',
  description: 'Lifts a ban or timeout for a user on fire.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveUnban extends Node {
  static readonly kind = 'overlive_unban';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('userId', 'String') userId!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const cfg = (this.config ?? {}) as { userId?: string };
    const userId = strOf(this.userId, cfg.userId);
    if (!userId) return;
    void getOverliveManager().unbanUser(accountId, userId);
    this.done.emit(undefined);
  }
}

/**
 * Delete a single chat message on `fire`, or clear the whole chat when
 * `messageId` is blank. Requires `moderator:manage:chat_messages`.
 */
@SignalNode({
  label: 'Overlive Delete Message',
  description: 'Deletes a chat message by id on fire, or clears all chat when the id is blank.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveDeleteMessage extends Node {
  static readonly kind = 'overlive_delete_message';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('messageId', 'String') messageId!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const cfg = (this.config ?? {}) as { messageId?: string };
    void getOverliveManager().deleteChatMessage(accountId, strOf(this.messageId, cfg.messageId) || undefined);
    this.done.emit(undefined);
  }
}

/**
 * Update chat modes on `fire`. Each port: `on`/`off` toggles a mode; the
 * followers/slow ports also accept a number (minutes/seconds). Blank leaves a
 * mode unchanged. Requires `moderator:manage:chat_settings`.
 */
@SignalNode({
  label: 'Overlive Chat Settings',
  description: 'Sets chat modes on fire (emote/subscribers/unique = on/off; followers/slow = on/off or a number). Blank = unchanged.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveChatSettings extends Node {
  static readonly kind = 'overlive_chat_settings';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('emoteOnly', 'String') emoteOnly!: () => string | undefined;
  @valueIn('followers', 'String') followers!: () => string | undefined;
  @valueIn('slow', 'String') slow!: () => string | undefined;
  @valueIn('subscribersOnly', 'String') subscribersOnly!: () => string | undefined;
  @valueIn('uniqueChat', 'String') uniqueChat!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const settings: {
      emoteOnly?: boolean;
      followersOnly?: boolean | number;
      slowMode?: boolean | number;
      subscribersOnly?: boolean;
      uniqueChat?: boolean;
    } = {};
    const emote = toggle(this.emoteOnly());
    if (emote !== undefined) settings.emoteOnly = emote;
    const subs = toggle(this.subscribersOnly());
    if (subs !== undefined) settings.subscribersOnly = subs;
    const uniq = toggle(this.uniqueChat());
    if (uniq !== undefined) settings.uniqueChat = uniq;
    const followers = durationSetting(this.followers());
    if (followers !== undefined) settings.followersOnly = followers;
    const slow = durationSetting(this.slow());
    if (slow !== undefined) settings.slowMode = slow;
    void getOverliveManager().updateChatSettings(accountId, settings);
    this.done.emit(undefined);
  }
}

/** Warn a user on `fire`. Requires `moderator:manage:warnings`. */
@SignalNode({
  label: 'Overlive Warn',
  description: 'Issues a warning to a user (with a reason) on fire.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveWarn extends Node {
  static readonly kind = 'overlive_warn';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('userId', 'String') userId!: () => string | undefined;
  @valueIn('reason', 'String') reason!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const cfg = (this.config ?? {}) as { userId?: string; reason?: string };
    const userId = strOf(this.userId, cfg.userId);
    const reason = strOf(this.reason, cfg.reason);
    if (!userId || !reason) return;
    void getOverliveManager().warnUser(accountId, userId, reason);
    this.done.emit(undefined);
  }
}

/**
 * Approve or deny an AutoMod-held message on `fire`. `action` is `ALLOW`
 * (default) or `DENY`. Requires `moderator:manage:automod`.
 */
@SignalNode({
  label: 'Overlive AutoMod',
  description: 'Approves or denies an AutoMod-held message on fire (action: ALLOW/DENY).',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveAutoMod extends Node {
  static readonly kind = 'overlive_automod';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('messageId', 'String') messageId!: () => string | undefined;
  @valueIn('action', 'String') action!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const cfg = (this.config ?? {}) as { messageId?: string; action?: string };
    const messageId = strOf(this.messageId, cfg.messageId);
    if (!messageId) return;
    void getOverliveManager().manageAutoMod(accountId, messageId, strOf(this.action, cfg.action) || 'ALLOW');
    this.done.emit(undefined);
  }
}
