import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
} from '@vspark/shared/signal';
import type { AdEndEvent } from '@overlive/core';
import { handleOverliveEvent } from './_helpers.js';

@SignalNode({
  label: 'Overlive Ad End',
  description: 'Fires when an ad break ends.',
  tags: ['overlive', 'input'],
  color: '#9146ff',
})
export class OverliveAdEnd {
  static readonly kind = 'overlive_ad_end';
  static readonly inputPorts = [
    valuePort('account', 'Account'),
    valuePort('channel', 'String'),
    eventPort('event', 'Any'),
  ] as const;
  static readonly outputPorts = [
    eventPort('event', 'Trigger'),
    valuePort('durationSeconds', 'Float'),
  ] as const;

  static execute(
    inputs: InputsOf<typeof OverliveAdEnd>,
    _config: unknown,
    ctx: NodeExecutionContext
  ): OutputsOf<typeof OverliveAdEnd> {
    return handleOverliveEvent<AdEndEvent, { durationSeconds: number }>(
      inputs,
      ctx,
      (e) => ({ durationSeconds: e.data.durationSeconds }),
      { durationSeconds: 0 }
    ) as OutputsOf<typeof OverliveAdEnd>;
  }
}
