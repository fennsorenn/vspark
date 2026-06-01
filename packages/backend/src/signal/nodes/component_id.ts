import { SignalNode, valuePort } from '@vspark/shared/signal';
import type { OutputsOf, NodeExecutionContext } from '@vspark/shared/signal';

export interface ComponentIdConfig {
  componentId: string;
}

@SignalNode({
  label: 'Component ID',
  tags: ['context'],
  color: '#2a2a4a',
  internal: true,
})
export class ComponentId {
  static readonly kind = 'component_id';
  static readonly inputPorts = [] as const;
  static readonly outputPorts = [valuePort('id', 'String')] as const;

  static execute(
    _: Record<string, never>,
    config: ComponentIdConfig,
    _ctx: NodeExecutionContext
  ): OutputsOf<typeof ComponentId> {
    return { id: config.componentId };
  }
}
