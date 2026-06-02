import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';

@SignalNode({
  label: 'NOT',
  description:
    'Boolean negation. Outputs !value. Treats null/undefined as false (so output defaults to true).',
  tags: ['logic'],
  color: '#3a3a3a',
})
export class NotBool extends Node {
  static readonly kind = 'not_bool';

  @valueIn('value', 'Bool') value!: () => boolean | null | undefined;

  @valueOut('result', 'Bool')
  result = (): boolean => !(this.value() ?? false);
}
