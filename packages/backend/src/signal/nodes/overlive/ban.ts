import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
} from '@vspark/shared/signal';
import type { BanEvent } from '@overlive/core';
import { handleOverliveEvent } from './_helpers.js';

@SignalNode({
  label: 'Overlive Ban',
  description: 'Fires on bans and timeouts. timeoutSeconds = 0 when permanent.',
  tags: ['overlive', 'input'],
  color: '#9146ff',
})
export class OverliveBan {
  static readonly kind = 'overlive_ban';
  static readonly inputPorts = [
    valuePort('account', 'Account'),
    valuePort('channel', 'String'),
    eventPort('event', 'Any'),
  ] as const;
  static readonly outputPorts = [
    eventPort('event', 'Trigger'),
    valuePort('username', 'String'),
    valuePort('displayName', 'String'),
    valuePort('moderatorName', 'String'),
    valuePort('reason', 'String'),
    valuePort('timeoutSeconds', 'Float'),
    valuePort('isPermanent', 'Bool'),
  ] as const;

  static execute(
    inputs: InputsOf<typeof OverliveBan>,
    _config: unknown,
    ctx: NodeExecutionContext
  ): OutputsOf<typeof OverliveBan> {
    return handleOverliveEvent<
      BanEvent,
      {
        username: string;
        displayName: string;
        moderatorName: string;
        reason: string;
        timeoutSeconds: number;
        isPermanent: boolean;
      }
    >(
      inputs,
      ctx,
      (e) => ({
        username: e.data.username,
        displayName: e.data.displayName,
        moderatorName: e.data.moderator?.username ?? '',
        reason: e.data.reason ?? '',
        timeoutSeconds: e.data.timeoutSeconds ?? 0,
        isPermanent: e.data.isPermanent,
      }),
      {
        username: '',
        displayName: '',
        moderatorName: '',
        reason: '',
        timeoutSeconds: 0,
        isPermanent: false,
      }
    ) as OutputsOf<typeof OverliveBan>;
  }
}
