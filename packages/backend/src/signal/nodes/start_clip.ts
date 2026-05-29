import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
} from '@vspark/shared/signal';
import type { TrackClipPlaybackManager } from '../../track_clips/playback.js';

let _playback: TrackClipPlaybackManager | null = null;
export function initStartClip(mgr: TrackClipPlaybackManager): void {
  _playback = mgr;
}

interface StartClipConfig {
  /** Scene-scoped id of the track clip to start. */
  clipId?: string;
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
  tags: ['clips', 'output'],
  color: '#3a5a7a',
})
export class StartClip {
  static readonly kind = 'start_clip';
  static readonly inputPorts = [
    eventPort('fire', 'Trigger'),
    valuePort('clipId', 'String'),
  ] as const;
  static readonly outputPorts = [] as const;

  static execute(
    inputs: InputsOf<typeof StartClip>,
    config: StartClipConfig,
    ctx: NodeExecutionContext
  ): OutputsOf<typeof StartClip> {
    if (ctx.triggeredPort !== 'fire')
      return {} as OutputsOf<typeof StartClip>;
    const clipId = (inputs.clipId as string | undefined) || config.clipId;
    if (!clipId || !_playback) return {} as OutputsOf<typeof StartClip>;
    _playback.trigger(clipId);
    return {} as OutputsOf<typeof StartClip>;
  }
}
