import { SignalNode } from '@vspark/shared/signal';
import type { IkTargetFrame } from '@vspark/shared/types';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { WSSync } from '../../ws/index.js';

let _ws: WSSync | null = null;
export function initIkBroadcast(ws: WSSync): void {
  _ws = ws;
}

/** Optional tap on every emitted IK frame, for multiplayer fan-out to subscribers. */
let _forward:
  | ((kind: string, nodeId: string, payload: Record<string, unknown>) => void)
  | null = null;
export function setIkStreamForwarder(
  fn: (kind: string, nodeId: string, payload: Record<string, unknown>) => void
): void {
  _forward = fn;
}

@SignalNode({
  label: 'Send IK Targets',
  description:
    'Broadcasts an IkTargetFrame to all WebSocket clients as a pose_ik_targets message. Reference bone is set by the upstream IK targets node config.',
  tags: ['output'],
  color: '#7a3a9a',
})
export class IkBroadcast extends Node {
  static readonly kind = 'ik_broadcast';

  @valueIn('targets', 'IkTargets') targets!: () => IkTargetFrame | undefined;
  @valueIn('nodeId', 'SceneNode') nodeId!: () => string | undefined;
  @valueIn('enabled', 'Bool') enabledIn!: () => boolean | null | undefined;

  @eventIn('trigger', 'Trigger')
  onTrigger(): void {
    const enabled = this.enabledIn() ?? true;
    if (!enabled) return;
    const nodeId = this.nodeId();
    const targets = this.targets();
    if (!nodeId || !targets) return;
    const payload = { ...targets, nodeId };
    _ws?.broadcast('pose_ik_targets', payload);
    _forward?.('pose_ik_targets', nodeId, payload);
  }
}
