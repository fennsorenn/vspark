import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { getObsWsManager } from '../../../obs/ws_manager.js';

/**
 * Switches OBS's active program scene over obs-websocket
 * (`SetCurrentProgramScene`). The scene name is taken from the wired `scene`
 * input when present, else `config.scene`. Requires an OBS connection for the
 * project; when there is none — or the request is rejected — the reason is
 * logged rather than swallowed.
 *
 * This used to go out over the browser-source bridge, where OBS silently
 * ignores `setCurrentScene` unless the source's page permission is raised to
 * "Advanced" — the graph reported success and nothing happened. obs-websocket
 * has no such gate and returns a status per request.
 */
@SignalNode({
  label: 'OBS Set Scene',
  description:
    "Switches OBS's active program scene by name over obs-websocket. Needs an OBS connection.",
  tags: ['obs'],
  color: '#5a3a5a',
})
export class ObsSetScene extends Node {
  static readonly kind = 'obs_set_scene';

  @valueIn('scene', 'String') scene!: () => string | undefined;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const cfg = (this.config ?? {}) as { _projectId?: string; scene?: string };
    // Pass an empty name through: the manager names the reason it can't act.
    getObsWsManager().setScene(
      cfg._projectId ?? '',
      this.scene() ?? cfg.scene ?? ''
    );
  }
}
