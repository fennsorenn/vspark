import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueOut } from '@vspark/shared/node_decorators';

export interface ComponentIdConfig {
  componentId: string;
}

@SignalNode({
  label: 'This Behavior',
  tags: ['context'],
  color: '#2a2a4a',
  internal: true,
})
export class ComponentId extends Node {
  static readonly kind = 'component_id';

  @valueOut('id', 'String')
  id = (): string =>
    (this.config as unknown as ComponentIdConfig).componentId;
}
