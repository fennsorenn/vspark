import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueOut } from '@vspark/shared/node_decorators';

@SignalNode({
  label: 'Time',
  description:
    'Lazily outputs the current time in seconds (Date.now() / 1000). Pulls a fresh value on every evaluation — no setup required.',
  tags: ['source', 'math'],
  color: '#4a7a5a',
})
export class Time extends Node {
  static readonly kind = 'time';

  @valueOut('seconds', 'Float')
  seconds = (): number => Date.now() / 1000;
}
