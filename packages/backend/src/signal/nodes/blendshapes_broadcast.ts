import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
} from '@vspark/shared/signal';
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
export class BlendshapesBroadcast {
  static readonly kind = 'blendshapes_broadcast';
  static readonly inputPorts = [
    eventPort('trigger', 'Trigger'),
    valuePort('blendshapes', 'Blendshapes'),
    valuePort('nodeId', 'EntityId'),
    valuePort('componentId', 'String'),
  ] as const;
  static readonly outputPorts = [] as const;

  static execute(
    inputs: InputsOf<typeof BlendshapesBroadcast>,
    _config: unknown,
    _ctx: NodeExecutionContext
  ): OutputsOf<typeof BlendshapesBroadcast> {
    const nodeId = inputs.nodeId as string | undefined;
    const componentId = inputs.componentId as string | undefined;
    const blendshapes = inputs.blendshapes as
      | import('@vspark/shared/signal').Blendshapes
      | undefined;
    if (!nodeId || !componentId || !blendshapes) return {};
    broadcastBus.publishBlendshapes(nodeId, componentId, blendshapes);
    return {};
  }
}
