import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
} from '@vspark/shared/signal';
import type { AdStartEvent } from '@overlive/core';
import { handleOverliveEvent } from './_helpers.js';

@SignalNode({
  label: 'Overlive Ad Start',
  description: 'Fires at the beginning of an ad break.',
  tags: ['overlive', 'input'],
  color: '#9146ff',
})
export class OverliveAdStart {
  static readonly kind = 'overlive_ad_start';
  static readonly inputPorts = [
    valuePort('account', 'Account'),
    valuePort('channel', 'String'),
    eventPort('event', 'Any'),
  ] as const;
  static readonly outputPorts = [
    eventPort('event', 'Trigger'),
    valuePort('durationSeconds', 'Float'),
    valuePort('isAutomatic', 'Bool'),
  ] as const;

  static execute(
    inputs: InputsOf<typeof OverliveAdStart>,
    _config: unknown,
    ctx: NodeExecutionContext
  ): OutputsOf<typeof OverliveAdStart> {
    return handleOverliveEvent<
      AdStartEvent,
      { durationSeconds: number; isAutomatic: boolean }
    >(
      inputs,
      ctx,
      (e) => ({
        durationSeconds: e.data.durationSeconds,
        isAutomatic: e.data.isAutomatic,
      }),
      { durationSeconds: 0, isAutomatic: false }
    ) as OutputsOf<typeof OverliveAdStart>;
  }
}
