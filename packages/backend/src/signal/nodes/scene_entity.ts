import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueOut } from '@vspark/shared/node_decorators';

export interface SceneEntityConfig {
  nodeId: string;
}

@SignalNode({
  label: 'Scene Entity',
  description:
    'Provides the ID of the scene node this component is attached to. Use as input to model property nodes.',
  tags: ['context'],
  color: '#2a2a4a',
  internal: true,
})
export class SceneEntity extends Node {
  static readonly kind = 'scene_entity';

  @valueOut('nodeId', 'SceneNode')
  nodeId = (): string => (this.config as unknown as SceneEntityConfig).nodeId;
}
