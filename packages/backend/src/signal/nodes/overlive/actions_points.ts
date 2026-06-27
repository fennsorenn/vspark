import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, eventOut } from '@vspark/shared/node_decorators';
import { getOverliveManager } from '../../../overlive/manager.js';
import { acct, strOf } from './_actions.js';

/**
 * Fulfil or cancel a channel-point redemption on `fire`. `status` is
 * `FULFILLED` (default) or `CANCELED`. Pairs with the inbound
 * `overlive_redemption` node, which provides `rewardId` + `redemptionId`.
 * Requires `channel:manage:redemptions`.
 */
@SignalNode({
  label: 'Overlive Redemption Status',
  description: 'Fulfils or cancels a channel-point redemption on fire (status: FULFILLED/CANCELED).',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveRedemptionStatus extends Node {
  static readonly kind = 'overlive_redemption_status';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('rewardId', 'String') rewardId!: () => string | undefined;
  @valueIn('redemptionId', 'String') redemptionId!: () => string | undefined;
  @valueIn('status', 'String') status!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const cfg = (this.config ?? {}) as { rewardId?: string; redemptionId?: string; status?: string };
    const rewardId = strOf(this.rewardId, cfg.rewardId);
    const redemptionId = strOf(this.redemptionId, cfg.redemptionId);
    if (!rewardId || !redemptionId) return;
    void getOverliveManager().updateRedemptionStatus(
      accountId,
      rewardId,
      redemptionId,
      strOf(this.status, cfg.status) || 'FULFILLED'
    );
    this.done.emit(undefined);
  }
}
