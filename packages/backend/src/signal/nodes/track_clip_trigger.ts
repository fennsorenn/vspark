import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import type { TrackClipPlaybackManager } from '../../track_clips/playback.js';

let _playback: TrackClipPlaybackManager | null = null;
export function initTrackClipTrigger(mgr: TrackClipPlaybackManager): void {
  _playback = mgr;
}

/**
 * Fires playback of a track clip when its `fire` event input receives a trigger.
 * The `clipId` value port takes precedence over the static config field, so the clip
 * can be selected dynamically (e.g. wired from a string source).
 */
@SignalNode({
  label: 'Track Clip Trigger',
  description:
    'Starts playback of a track clip on the configured scene when triggered.',
  tags: ['output'],
  color: '#3a5a7a',
})
export class TrackClipTrigger extends Node {
  static readonly kind = 'track_clip_trigger';

  @valueIn('clipId', 'String') clipId!: () => string | undefined;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const clipId = this.clipId();
    if (!clipId || !_playback) return;
    _playback.trigger(clipId);
  }
}
