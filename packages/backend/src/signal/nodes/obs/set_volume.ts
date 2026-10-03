import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { getObsWsManager } from '../../../obs/ws_manager.js';

/**
 * Sets an OBS audio input's volume over obs-websocket (`SetInputVolume`). The
 * input name comes from the wired `input` or `config.inputName`; the level from
 * the wired `value` or `config.value`, interpreted as dB or linear multiplier
 * per `config.mode`. Requires an OBS connection configured for the project
 * (Accounts → OBS Connections); no-ops when disconnected.
 */
@SignalNode({
  label: 'OBS Set Volume',
  description:
    "Set an OBS audio input's volume (dB or linear) over obs-websocket. Needs an OBS connection.",
  tags: ['obs'],
  color: '#5a3a5a',
})
export class ObsSetVolume extends Node {
  static readonly kind = 'obs_set_volume';

  @valueIn('input', 'String') input!: () => string | undefined;
  @valueIn('value', 'Float') value!: () => number | undefined;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const cfg = (this.config ?? {}) as {
      _projectId?: string;
      inputName?: string;
      mode?: 'db' | 'mul';
      value?: number;
    };
    const projectId = cfg._projectId ?? '';
    const inputName = (this.input() ?? cfg.inputName ?? '').trim();
    const level = this.value() ?? cfg.value;
    if (!projectId || !inputName || typeof level !== 'number') return;
    const value =
      cfg.mode === 'mul' ? { mul: level } : { db: level };
    getObsWsManager().setVolume(projectId, inputName, value);
  }
}
