import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn } from '@vspark/shared/node_decorators';
import { getObsWsManager, isObsControlVerb } from '../../../obs/ws_manager.js';

/**
 * Issues an arg-less OBS control call selected by `config.action` — start/stop
 * streaming, recording (+ pause/unpause), the replay buffer (incl. saving it),
 * or the virtual camera. Goes out over obs-websocket, so it needs an OBS
 * connection for the project but no browser-source page permission.
 *
 * `config.action` still uses the old `window.obsstudio` verb names
 * (`startStreaming`, `unpauseRecording`, …) so graphs built against the browser
 * bridge keep working; `ObsWsManager` maps them onto obs-websocket requests.
 */
@SignalNode({
  label: 'OBS Control',
  description:
    'Start/stop streaming, recording, the replay buffer (incl. save), or the virtual camera over obs-websocket. Action chosen in config; needs an OBS connection.',
  tags: ['obs'],
  color: '#5a3a5a',
})
export class ObsControl extends Node {
  static readonly kind = 'obs_control';

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const cfg = (this.config ?? {}) as { _projectId?: string; action?: string };
    const action = cfg.action ?? '';
    if (!isObsControlVerb(action)) {
      console.warn(`[obs-ws] obs_control: unknown action "${action}"`);
      return;
    }
    getObsWsManager().control(cfg._projectId ?? '', action);
  }
}
