import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
  Event,
} from '@vspark/shared/signal';

/**
 * Prints whatever fires into `trigger` (and the current value of `input`)
 * to the backend console. Useful while authoring project graphs — drop one
 * after any node to confirm payloads flow as expected.
 *
 * Set `label` to disambiguate multiple log nodes in the same graph; it
 * prefixes every log line.
 */
@SignalNode({
  label: 'Log',
  description:
    'Logs the trigger event payload and the current value-input to the backend console.',
  tags: ['utility', 'debug'],
  color: '#3a3a3a',
})
export class LogNode {
  static readonly kind = 'log';
  static readonly inputPorts = [
    valuePort('label', 'String'),
    eventPort('trigger', 'Any'),
    valuePort('input', 'Any'),
  ] as const;
  static readonly outputPorts = [] as const;

  static execute(
    inputs: InputsOf<typeof LogNode>,
    config: { label?: string } | null | undefined,
    ctx: NodeExecutionContext
  ): OutputsOf<typeof LogNode> {
    if (ctx.triggeredPort !== 'trigger') return {} as OutputsOf<typeof LogNode>;
    const label = (
      typeof (inputs as { label?: unknown }).label === 'string'
        ? (inputs as { label: string }).label
        : (config?.label ?? '')
    ).trim();
    const evt = inputs.trigger as Event<unknown> | undefined;
    const prefix = label ? `[log:${label}]` : '[log]';
    // Print the event payload and the current pull-resolved value-input.
    // Both can be useful — the trigger payload is the thing that fired,
    // and `input` is whatever the pull-side resolved to (often the same).
    console.log(
      prefix,
      'event payload:',
      evt?.payload,
      '| input:',
      inputs.input
    );
    return {} as OutputsOf<typeof LogNode>;
  }
}
