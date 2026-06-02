import { SignalNode } from '@vspark/shared/signal';
import type { Blendshapes } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import type { WSSync } from '../../ws/index.js';
import { broadcastBus } from '../../broadcast/bus.js';

let _ws: WSSync | null = null;
export function initBlendshapesBroadcast(ws: WSSync): void {
  _ws = ws;
  broadcastBus.init(ws);
}

@SignalNode({
  label: 'Blendshapes Broadcast',
  description:
    'Publishes VRM expression weights to the Broadcast Bus. The bus sums all producer slots for the entity (clamped to [0,1]) and emits a merged frame on each scene tick.',
  tags: ['output'],
  color: '#7a3a6a',
})
export class BlendshapesBroadcast extends Node {
  static readonly kind = 'blendshapes_broadcast';

  @valueIn('blendshapes', 'Blendshapes')
  blendshapes!: () => Blendshapes | undefined;
  @valueIn('nodeId', 'EntityId') nodeId!: () => string | undefined;
  @valueIn('componentId', 'String') componentId!: () => string | undefined;

  @eventIn('trigger', 'Trigger')
  onTrigger(): void {
    const nodeId = this.nodeId();
    const componentId = this.componentId();
    const blendshapes = this.blendshapes();
    if (!nodeId || !componentId || !blendshapes) return;
    broadcastBus.publishBlendshapes(nodeId, componentId, blendshapes);
  }
}
