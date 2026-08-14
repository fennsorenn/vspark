import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { getObsManager } from '../../../obs/manager.js';

/**
 * Sets OBS's active transition (`window.obsstudio.setCurrentTransition`). The
 * transition name comes from the wired `transition` input or `config.transition`.
 * Requires OBS page permission level ADVANCED (4).
 */
@SignalNode({
  label: 'OBS Set Transition',
  description:
    "Sets OBS's active scene transition by name (requires OBS page permission ‘Advanced’).",
  tags: ['obs'],
  color: '#5a3a5a',
})
export class ObsSetTransition extends Node {
  static readonly kind = 'obs_set_transition';

  @valueIn('transition', 'String') transition!: () => string | undefined;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const cfg = (this.config ?? {}) as { transition?: string };
    const name = (this.transition() ?? cfg.transition ?? '').trim();
    if (!name) return;
    getObsManager().command({ verb: 'setCurrentTransition', arg: name });
  }
}
