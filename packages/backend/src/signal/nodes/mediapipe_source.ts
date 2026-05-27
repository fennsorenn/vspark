import { SignalNode, eventPort } from '@vspark/shared/signal';
import type { OutputsOf, NodeExecutionContext } from '@vspark/shared/signal';

@SignalNode({
  label: 'MediaPipe Source',
  description:
    'Entry point for MediaPipe Holistic landmark data pushed from the browser camera. Fired by TrackingManager for each frame.',
  tags: ['input'],
  color: '#4a5a8a',
  internal: true,
})
export class MediapipeSource {
  static readonly kind = 'mediapipe_source';
  static readonly inputPorts = [] as const;
  static readonly outputPorts = [
    eventPort('face', 'LandmarkList'),
    eventPort('leftHand', 'LandmarkList'),
    eventPort('rightHand', 'LandmarkList'),
    eventPort('pose', 'LandmarkList'),
  ] as const;

  static execute(
    _inputs: Record<string, unknown>,
    _config: unknown,
    _ctx: NodeExecutionContext
  ): OutputsOf<typeof MediapipeSource> {
    // Fired externally by TrackingManager via graph.fire() — execute() is never called normally.
    return {} as OutputsOf<typeof MediapipeSource>;
  }
}
