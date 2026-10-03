import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { getObsWsManager } from '../../../obs/ws_manager.js';

/**
 * Sets OBS's active scene transition over obs-websocket
 * (`SetCurrentSceneTransition`). The transition name comes from the wired
 * `transition` input or `config.transition`. Requires an OBS connection for the
 * project; when there is none — or the request is rejected — the reason is
 * logged rather than swallowed.
 */
@SignalNode({
  label: 'OBS Set Transition',
  description:
    "Sets OBS's active scene transition by name over obs-websocket. Needs an OBS connection.",
  tags: ['obs'],
  color: '#5a3a5a',
})
export class ObsSetTransition extends Node {
  static readonly kind = 'obs_set_transition';

  @valueIn('transition', 'String') transition!: () => string | undefined;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const cfg = (this.config ?? {}) as {
      _projectId?: string;
      transition?: string;
    };
    // Pass an empty name through: the manager names the reason it can't act.
    getObsWsManager().setTransition(
      cfg._projectId ?? '',
      this.transition() ?? cfg.transition ?? ''
    );
  }
}
