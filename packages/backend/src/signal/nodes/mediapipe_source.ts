import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventOut } from '@vspark/shared/node_decorators';
import type { SignalTypeMap } from '@vspark/shared/signal';

type LandmarkList = SignalTypeMap['LandmarkList'];

/**
 * Entry point for MediaPipe Holistic landmark data pushed from the browser camera.
 * TrackingManager fires each output directly via graph.fire() per frame; the node
 * only declares the output ports.
 */
@SignalNode({
  label: 'MediaPipe Source',
  description:
    'Entry point for MediaPipe Holistic landmark data pushed from the browser camera. Fired by TrackingManager for each frame.',
  tags: ["input"],
  color: '#4a5a8a',
  internal: true,
})
export class MediapipeSource extends Node {
  static readonly kind = 'mediapipe_source';

  @eventOut('face', 'LandmarkList') face!: Emitter<LandmarkList>;
  @eventOut('leftHand', 'LandmarkList') leftHand!: Emitter<LandmarkList>;
  @eventOut('rightHand', 'LandmarkList') rightHand!: Emitter<LandmarkList>;
  @eventOut('pose', 'LandmarkList') pose!: Emitter<LandmarkList>;
}
