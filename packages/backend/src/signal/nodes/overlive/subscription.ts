import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'
import type { SubscriptionEvent } from '@overlive/core'
import { handleOverliveEvent } from './_helpers.js'

/** Subscription event (new sub, resub message, or gifted sub recipient). */
@SignalNode({
  label:       'Overlive Subscription',
  description: 'Fires on new subs, resubs, and gifted subs (recipients). For bulk gifts see Overlive Gift Bomb.',
  tags:        ['overlive', 'input'],
  color:       '#9146ff',
})
export class OverliveSubscription {
  static readonly kind = 'overlive_subscription'
  static readonly inputPorts = [
    valuePort('account', 'Account'),
    valuePort('channel', 'String'),
    valuePort('tier',    'String'),   // '' | 'tier1' | 'tier2' | 'tier3' | 'prime'
    valuePort('isGift',  'String'),   // '' | 'true' | 'false'
    eventPort('event',   'Any'),
  ] as const
  static readonly outputPorts = [
    eventPort('event',       'Trigger'),
    valuePort('username',    'String'),
    valuePort('displayName', 'String'),
    valuePort('tier',        'String'),
    valuePort('months',      'Float'),
    valuePort('isFirst',     'Bool'),
    valuePort('isResub',     'Bool'),
    valuePort('isGift',      'Bool'),
    valuePort('message',     'String'),
  ] as const

  static execute(
    inputs: InputsOf<typeof OverliveSubscription>,
    config: { tier?: string; isGift?: string } | null | undefined,
    ctx: NodeExecutionContext,
  ): OutputsOf<typeof OverliveSubscription> {
    const wantTier   = (config?.tier   ?? '').trim()
    const wantIsGift = (config?.isGift ?? '').trim()
    return handleOverliveEvent<SubscriptionEvent, {
      username: string; displayName: string; tier: string; months: number
      isFirst: boolean; isResub: boolean; isGift: boolean; message: string
    }>(
      inputs,
      ctx,
      (e) => ({
        username:    e.data.username,
        displayName: e.data.displayName,
        tier:        e.data.tier,
        months:      e.data.months,
        isFirst:     e.data.isFirst,
        isResub:     e.data.isResub,
        isGift:      e.data.isGift,
        message:     e.data.message ?? '',
      }),
      { username: '', displayName: '', tier: '', months: 0, isFirst: false, isResub: false, isGift: false, message: '' },
      (e) => {
        if (wantTier   && e.data.tier !== wantTier) return false
        if (wantIsGift === 'true'  && !e.data.isGift) return false
        if (wantIsGift === 'false' &&  e.data.isGift) return false
        return true
      },
    ) as OutputsOf<typeof OverliveSubscription>
  }
}
