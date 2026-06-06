import { SignalNode } from '@vspark/shared/signal';
import type { NormalizedPose } from '@vspark/shared/signal';
import type { AnimationBlendMode } from '@vspark/shared';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import type { WSSync } from '../../ws/index.js';
import { broadcastBus } from '../../broadcast/bus.js';

let _ws: WSSync | null = null;
export function initPoseBroadcast(ws: WSSync): void {
  _ws = ws;
  broadcastBus.init(ws);
}

/** Legacy direct emit, retained for any caller that needs to bypass the bus.
 *  All graph nodes should publish through the bus instead. */
export function broadcastPose(nodeId: string, pose: NormalizedPose): void {
  _ws?.broadcast('vmc_pose', { nodeId, bones: pose.toRecord() });
}

@SignalNode({
  label: 'Send Pose',
  description:
    'Publishes the processed NormalizedPose to the Broadcast Bus. The bus composes slots from all producers attached to this entity and emits a merged pose on each scene tick.',
  tags: ['output'],
  color: '#7a3a6a',
})
export class PoseBroadcast extends Node {
  static readonly kind = 'pose_broadcast';

  @valueIn('pose', 'NormalizedPose') pose!: () => NormalizedPose | undefined;
  @valueIn('nodeId', 'SceneNode') nodeId!: () => string | undefined;
  @valueIn('componentId', 'String') componentId!: () => string | undefined;
  @valueIn('priority', 'Float') priority!: () => number | undefined;
  @valueIn('animationBlendMode', 'String')
  animationBlendMode!: () => string | undefined;

  @eventIn('trigger', 'Trigger')
  onTrigger(): void {
    const nodeId = this.nodeId();
    const componentId = this.componentId();
    const pose = this.pose();
    if (!nodeId || !componentId || !pose) return;
    const priority = _asPriority(this.priority());
    const mode = _asMode(this.animationBlendMode());
    broadcastBus.publishBones(nodeId, componentId, pose, priority, mode);
  }
}

function _asPriority(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return 0;
}

function _asMode(v: unknown): AnimationBlendMode {
  return v === 'additive' ? 'additive' : 'override';
}
