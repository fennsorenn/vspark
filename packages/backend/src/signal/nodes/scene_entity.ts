import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueOut } from '@vspark/shared/node_decorators';

export interface SceneEntityConfig {
  /** The owner entity's id, injected by the host manager: the attached scene
   *  node for component graphs and scene-node-scoped graphs, or the compose
   *  layer id for compose-layer-scoped graphs. */
  nodeId: string;
}

@SignalNode({
  label: 'This Entity',
  description:
    'Outputs the id of the entity this graph is scoped to — a scene node or a compose layer. Wire into target/scope inputs.',
  tags: ["utility"],
  color: '#2a2a4a',
  internal: true,
})
export class SceneEntity extends Node {
  static readonly kind = 'scene_entity';

  // Output TYPE follows the graph scope (SceneNode vs ComposeLayer) via
  // `inferSceneEntity` in shared/infer_nodes.ts; the tag here is the default
  // (scene-node / component graphs). The runtime VALUE is always a bare id.
  @valueOut('nodeId', 'SceneNode')
  nodeId = (): string => (this.config as unknown as SceneEntityConfig).nodeId;
}
