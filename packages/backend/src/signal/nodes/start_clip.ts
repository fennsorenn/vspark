import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import type { TrackClipPlaybackManager } from '../../track_clips/playback.js';

let _playback: TrackClipPlaybackManager | null = null;
export function initStartClip(mgr: TrackClipPlaybackManager): void {
  _playback = mgr;
}

/**
 * Canonical name for starting playback of a track clip. The legacy
 * `track_clip_trigger` node remains registered for back-compat; new graphs
 * should use this kind.
 */
@SignalNode({
  label: 'Start Clip',
  description:
    'Starts playback of a track clip when triggered. Canonical name; supersedes track_clip_trigger.',
  tags: ["clips"],
  color: '#3a5a7a',
})
export class StartClip extends Node {
  static readonly kind = 'start_clip';

  @valueIn('clipId', 'String') clipId!: () => string | undefined;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const clipId = this.clipId();
    if (!clipId || !_playback) return;
    _playback.trigger(clipId);
  }
}
