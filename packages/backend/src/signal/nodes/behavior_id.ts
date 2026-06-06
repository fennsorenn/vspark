import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueOut } from '@vspark/shared/node_decorators';

export interface BehaviorIdConfig {
  behaviorId: string;
}

@SignalNode({
  label: 'This Behavior',
  tags: ['context'],
  color: '#2a2a4a',
  internal: true,
})
export class BehaviorId extends Node {
  static readonly kind = 'behavior_id';

  @valueOut('id', 'String')
  id = (): string =>
    (this.config as unknown as BehaviorIdConfig).behaviorId;
}
