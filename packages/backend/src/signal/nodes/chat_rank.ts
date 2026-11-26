import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';

/** Chat ranks, lowest first. A chatter's rank is the highest one they hold. */
export const CHAT_RANKS = ['everyone', 'sub', 'mod', 'broadcaster'] as const;
export type ChatRank = (typeof CHAT_RANKS)[number];

/**
 * Pure permission check for chat events: is the chatter at least `minRank`?
 * Wire the `isSub` / `isMod` / `isBroadcaster` outputs of a chat trigger in.
 * Ranks, lowest first: `everyone`, `sub`, `mod`, `broadcaster` (the
 * broadcaster outranks a mod). An empty `minRank` means `everyone`; a value
 * that is not one of the ranks never allows.
 */
@SignalNode({
  label: 'Chat Rank',
  description:
    'Outputs true when the chatter has at least the minimum rank: everyone, sub, mod or broadcaster. Wire in the isSub / isMod / isBroadcaster outputs of a chat trigger.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class ChatRankNode extends Node {
  static readonly kind = 'chat_rank';

  @valueIn('isSub', 'Bool') isSub!: () => unknown;
  @valueIn('isMod', 'Bool') isMod!: () => unknown;
  @valueIn('isBroadcaster', 'Bool') isBroadcaster!: () => unknown;
  @valueIn('minRank', 'String') minRank!: () => unknown;

  @valueOut('allowed', 'Bool') allowed = (): boolean => {
    const raw = this.minRank();
    const want =
      typeof raw === 'string' && raw.trim() !== ''
        ? raw.trim().toLowerCase()
        : 'everyone';
    const need = CHAT_RANKS.indexOf(want as ChatRank);
    if (need < 0) return false;
    const have =
      this.isBroadcaster() === true
        ? 3
        : this.isMod() === true
          ? 2
          : this.isSub() === true
            ? 1
            : 0;
    return have >= need;
  };
}
