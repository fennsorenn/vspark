import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueOut } from '@vspark/shared/node_decorators';

/**
 * Outputs the id of the Logic graph it runs in, injected by `LogicManager` as
 * `config._logicId`. Wire it into a variable node's `scope` to keep a variable
 * private to this graph (deleting the graph deletes the variables scoped to
 * its id). Empty outside a Logic graph.
 */
@SignalNode({
  label: 'This Logic',
  description:
    'Outputs the id of this Logic graph. Use it as a variable scope to keep variables private to this graph.',
  tags: ['variables'],
  color: '#2a2a4a',
})
export class LogicId extends Node {
  static readonly kind = 'logic_id';

  @valueOut('id', 'String') id = (): string => {
    const v = (this.config as { _logicId?: unknown })._logicId;
    return typeof v === 'string' ? v : '';
  };
}
