import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { triggerClip } from '../../track_clips/playbackDoc.js';

/**
 * Fires playback of a track clip when its `fire` event input receives a trigger.
 * The `clipId` value port takes precedence over the static config field, so the clip
 * can be selected dynamically (e.g. wired from a string source).
 */
@SignalNode({
  label: 'Track Clip Trigger',
  description:
    'Starts playback of a track clip on the configured scene when triggered.',
  tags: ["clips"],
  color: '#3a5a7a',
})
export class TrackClipTrigger extends Node {
  static readonly kind = 'track_clip_trigger';

  @valueIn('clipId', 'String') clipId!: () => string | undefined;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const clipId = this.clipId();
    if (!clipId) return;
    // Writes the clip_playback document; every peer derives the playhead
    // from it. No injected playhead to be missing.
    triggerClip(clipId);
  }
}
