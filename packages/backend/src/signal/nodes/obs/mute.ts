import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { getObsWsManager } from '../../../obs/ws_manager.js';

/**
 * Mutes, unmutes, or toggles an OBS audio input over obs-websocket
 * (`SetInputMute` / `ToggleInputMute`). Input name from the wired `input` or
 * `config.inputName`; `config.action` selects mute / unmute / toggle. Requires
 * an OBS connection for the project; no-ops when disconnected.
 */
@SignalNode({
  label: 'OBS Mute',
  description:
    'Mute / unmute / toggle an OBS audio input over obs-websocket. Needs an OBS connection.',
  tags: ['obs'],
  color: '#5a3a5a',
})
export class ObsMute extends Node {
  static readonly kind = 'obs_mute';

  @valueIn('input', 'String') input!: () => string | undefined;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const cfg = (this.config ?? {}) as {
      _projectId?: string;
      inputName?: string;
      action?: 'mute' | 'unmute' | 'toggle';
    };
    const projectId = cfg._projectId ?? '';
    const inputName = (this.input() ?? cfg.inputName ?? '').trim();
    if (!projectId || !inputName) return;
    getObsWsManager().setMute(projectId, inputName, cfg.action ?? 'toggle');
  }
}
