import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { valueIn, eventOut } from '@vspark/shared/node_decorators';

/**
 * Emits a Trigger event when fired externally via graph.fire(nodeId, 'trigger', event).
 * The `button` value input names the button label shown in the component's property panel —
 * wire it or set it statically. There is no reaction; the node is fired from, not delivered to.
 */
@SignalNode({
  label: 'Component Trigger',
  description:
    'Emits a trigger event when its button is pressed in the component property panel.',
  tags: ['input'],
  color: '#3a3a5a',
})
export class ManualTrigger extends Node {
  static readonly kind = 'component_trigger';

  @valueIn('button', 'String') button!: () => string | undefined;

  @eventOut('trigger', 'Trigger') trigger!: Emitter<void>;
}
