import { SignalNode } from '@vspark/shared/signal';
import type { NormalizedPose, InterceptorFrame } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { poseInterceptorRegistry } from '../pose_interceptor_registry.js';
import { broadcastBus } from '../../broadcast/bus.js';

@SignalNode({
  label: 'Pose Interceptor Broadcast',
  description:
    'Advances the pose interceptor chain. Wire the frame from On Pose Broadcast and the (optionally modified) pose, then connect trigger from the end of your pipeline.',
  tags: ['interceptor', 'output'],
  color: '#4a6a9f',
})
export class PoseInterceptorBroadcast extends Node {
  static readonly kind = 'pose_interceptor_broadcast';

  @valueIn('frame', 'InterceptorFrame') frame!: () => InterceptorFrame | undefined;
  @valueIn('pose', 'NormalizedPose') pose!: () => NormalizedPose | undefined;

  @eventIn('trigger', 'Trigger')
  onTrigger(): void {
    const frame = this.frame();
    const pose = this.pose();
    if (!frame || !pose) return;
    poseInterceptorRegistry.advance(
      frame.nodeId,
      frame.priority,
      pose,
      (nodeId, finalPose) => {
        broadcastBus.emitMergedPose(nodeId, finalPose);
      }
    );
  }
}
