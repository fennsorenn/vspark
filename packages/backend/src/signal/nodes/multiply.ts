import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';

@SignalNode({
  label: 'Multiply',
  description:
    'Outputs a × b. Either input can be a literal (set on the unconnected handle) or come from another node.',
  tags: ["math"],
  color: '#4a7a5a',
})
export class Multiply extends Node {
  static readonly kind = 'multiply';

  @valueIn('a', 'Float') a!: () => number | undefined;
  @valueIn('b', 'Float') b!: () => number | undefined;

  @valueOut('value', 'Float')
  value = (): number => (this.a() ?? 0) * (this.b() ?? 0);
}
