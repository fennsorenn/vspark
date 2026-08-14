import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { getObsManager } from '../../../obs/manager.js';

/**
 * Switches OBS's active scene (`window.obsstudio.setCurrentScene`). The scene
 * name is taken from the wired `scene` input when present, else `config.scene`.
 * Requires the browser source's OBS page permission level ADVANCED (4); OBS
 * silently ignores the call below that.
 */
@SignalNode({
  label: 'OBS Set Scene',
  description:
    "Switches OBS's active program scene by name (requires OBS page permission ‘Advanced’).",
  tags: ['obs'],
  color: '#5a3a5a',
})
export class ObsSetScene extends Node {
  static readonly kind = 'obs_set_scene';

  @valueIn('scene', 'String') scene!: () => string | undefined;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const cfg = (this.config ?? {}) as { scene?: string };
    const name = (this.scene() ?? cfg.scene ?? '').trim();
    if (!name) return;
    getObsManager().command({ verb: 'setCurrentScene', arg: name });
  }
}
