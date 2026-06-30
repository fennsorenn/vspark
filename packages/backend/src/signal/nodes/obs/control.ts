import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn } from '@vspark/shared/node_decorators';
import type { ObsCommand } from '@vspark/shared';
import { getObsManager } from '../../../obs/manager.js';

/** Arg-less OBS control verbs this node can issue. */
const VERBS = new Set<ObsCommand['verb']>([
  'startStreaming',
  'stopStreaming',
  'startRecording',
  'stopRecording',
  'pauseRecording',
  'unpauseRecording',
  'startReplayBuffer',
  'stopReplayBuffer',
  'saveReplayBuffer',
  'startVirtualcam',
  'stopVirtualcam',
]);

/**
 * Issues an arg-less OBS control call selected by `config.action` — start/stop
 * streaming, recording (+ pause/unpause), the replay buffer (incl.
 * `saveReplayBuffer`), or the virtual camera. `saveReplayBuffer` needs OBS page
 * permission BASIC (3); replay start/stop needs ADVANCED (4); streaming /
 * recording / virtualcam need ALL (5). OBS silently ignores calls above the
 * source's level.
 */
@SignalNode({
  label: 'OBS Control',
  description:
    'Start/stop streaming, recording, the replay buffer (incl. save), or the virtual camera. Action chosen in config; permission-gated by OBS.',
  tags: ['obs'],
  color: '#5a3a5a',
})
export class ObsControl extends Node {
  static readonly kind = 'obs_control';

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const cfg = (this.config ?? {}) as { action?: string };
    const verb = cfg.action as ObsCommand['verb'] | undefined;
    if (!verb || !VERBS.has(verb)) return;
    getObsManager().command({ verb });
  }
}
