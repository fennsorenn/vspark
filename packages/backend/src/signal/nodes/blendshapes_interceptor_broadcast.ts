import { SignalNode } from '@vspark/shared/signal';
import type {
  Blendshapes,
  BlendshapeInterceptorFrame,
} from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { blendshapeInterceptorRegistry } from '../blendshape_interceptor_registry.js';
import { broadcastBus } from '../../broadcast/bus.js';

@SignalNode({
  label: 'Send Intercepted Blendshapes',
  description:
    'Advances the blendshape interceptor chain. Wire the frame from Intercept Blendshapes and the (optionally modified) weights, then connect trigger from the end of your pipeline.',
  tags: ['output'],
  color: '#7a3a6a',
})
export class BlendshapesInterceptorBroadcast extends Node {
  static readonly kind = 'blendshapes_interceptor_broadcast';

  @valueIn('frame', 'BlendshapeInterceptorFrame')
  frame!: () => BlendshapeInterceptorFrame | undefined;
  @valueIn('blendshapes', 'Blendshapes')
  blendshapes!: () => Blendshapes | undefined;

  @eventIn('trigger', 'Trigger')
  onTrigger(): void {
    const frame = this.frame();
    const blendshapes = this.blendshapes();
    if (!frame || !blendshapes) return;
    blendshapeInterceptorRegistry.advance(
      frame.nodeId,
      frame.priority,
      blendshapes,
      (nodeId, final) => {
        broadcastBus.emitMergedBlendshapes(nodeId, final);
      }
    );
  }
}
