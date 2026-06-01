import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
} from '@vspark/shared/signal';
import type { TrackClipPlaybackManager } from '../../track_clips/playback.js';

let _playback: TrackClipPlaybackManager | null = null;
export function initTrackClipTrigger(mgr: TrackClipPlaybackManager): void {
  _playback = mgr;
}

interface TrackClipTriggerConfig {
  /** Scene-scoped id of the track clip to trigger. Set via the property panel. */
  clipId?: string;
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
export class TrackClipTrigger {
  static readonly kind = 'track_clip_trigger';
  static readonly inputPorts = [
    eventPort('fire', 'Trigger'),
    valuePort('clipId', 'String'),
  ] as const;
  static readonly outputPorts = [] as const;

  static execute(
    inputs: InputsOf<typeof TrackClipTrigger>,
    config: TrackClipTriggerConfig,
    ctx: NodeExecutionContext
  ): OutputsOf<typeof TrackClipTrigger> {
    // Only act on the event delivery, not on stray value pulls.
    if (ctx.triggeredPort !== 'fire')
      return {} as OutputsOf<typeof TrackClipTrigger>;
    const clipId = (inputs.clipId as string | undefined) || config.clipId;
    if (!clipId || !_playback) return {} as OutputsOf<typeof TrackClipTrigger>;
    _playback.trigger(clipId);
    return {} as OutputsOf<typeof TrackClipTrigger>;
  }
}
