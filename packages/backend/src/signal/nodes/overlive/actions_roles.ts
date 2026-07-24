import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, eventOut } from '@vspark/shared/node_decorators';
import { getOverliveManager } from '../../../overlive/manager.js';
import { acct, strOf } from './_actions.js';

/** Resolve `account` + `userId` (port → config), or null if either is missing.
 *  Config is passed in because `Node.config` is protected. */
function resolveUser(
  node: { account: () => unknown; userId: () => string | undefined },
  cfg: { account?: string; userId?: string }
): { accountId: string; userId: string } | null {
  const accountId = acct(node.account, cfg.account);
  if (!accountId) return null;
  const userId = strOf(node.userId, cfg.userId);
  if (!userId) return null;
  return { accountId, userId };
}

/** Grant VIP on `fire`. Requires `channel:manage:vips`. */
@SignalNode({
  label: 'Overlive Add VIP',
  description: 'Grants VIP to a user on fire.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveAddVip extends Node {
  static readonly kind = 'overlive_add_vip';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('userId', 'String') userId!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const r = resolveUser(this, (this.config ?? {}) as { account?: string; userId?: string });
    if (!r) return;
    void getOverliveManager().addVip(r.accountId, r.userId);
    this.done.emit(undefined);
  }
}

/** Remove VIP on `fire`. Requires `channel:manage:vips`. */
@SignalNode({
  label: 'Overlive Remove VIP',
  description: 'Removes VIP from a user on fire.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveRemoveVip extends Node {
  static readonly kind = 'overlive_remove_vip';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('userId', 'String') userId!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const r = resolveUser(this, (this.config ?? {}) as { account?: string; userId?: string });
    if (!r) return;
    void getOverliveManager().removeVip(r.accountId, r.userId);
    this.done.emit(undefined);
  }
}

/** Grant moderator on `fire`. Requires `channel:manage:moderators`. */
@SignalNode({
  label: 'Overlive Add Moderator',
  description: 'Grants moderator to a user on fire.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveAddModerator extends Node {
  static readonly kind = 'overlive_add_moderator';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('userId', 'String') userId!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const r = resolveUser(this, (this.config ?? {}) as { account?: string; userId?: string });
    if (!r) return;
    void getOverliveManager().addModerator(r.accountId, r.userId);
    this.done.emit(undefined);
  }
}

/** Remove moderator on `fire`. Requires `channel:manage:moderators`. */
@SignalNode({
  label: 'Overlive Remove Moderator',
  description: 'Removes moderator from a user on fire.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveRemoveModerator extends Node {
  static readonly kind = 'overlive_remove_moderator';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('userId', 'String') userId!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const r = resolveUser(this, (this.config ?? {}) as { account?: string; userId?: string });
    if (!r) return;
    void getOverliveManager().removeModerator(r.accountId, r.userId);
    this.done.emit(undefined);
  }
}
