import { SignalNode, valuePort } from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
} from '@vspark/shared/signal';

@SignalNode({
  label: 'Multiply',
  description:
    'Outputs a × b. Either input can be a literal (set on the unconnected handle) or come from another node.',
  tags: ['math'],
  color: '#4a7a5a',
})
export class Multiply {
  static readonly kind = 'multiply';
  static readonly inputPorts = [
    valuePort('a', 'Float'),
    valuePort('b', 'Float'),
  ] as const;
  static readonly outputPorts = [valuePort('value', 'Float')] as const;

  static execute(
    inputs: InputsOf<typeof Multiply>,
    _config: unknown,
    _ctx: NodeExecutionContext
  ): OutputsOf<typeof Multiply> {
    const a = (inputs.a as number | undefined) ?? 0;
    const b = (inputs.b as number | undefined) ?? 0;
    return { value: a * b };
  }
}
