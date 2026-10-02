import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, eventOut, valueOut } from '@vspark/shared/node_decorators';

interface MuteOut {
  input: string;
  muted: boolean;
}

const EMPTY: MuteOut = { input: '', muted: false };

interface MutePayload {
  input: string;
  muted: boolean;
}

/**
 * Fires when an OBS audio input's mute state changes (obs-websocket
 * `InputMuteStateChanged`). Outputs the input name and whether it is now muted.
 * Set `onlyInput` to react to a single input. Needs an OBS connection for the
 * project.
 */
@SignalNode({
  label: 'OBS Mute Changed',
  description:
    'Fires when an OBS audio input is muted or unmuted. Outputs input name and muted state.',
  tags: ['obs'],
  color: '#3a3a5a',
})
export class ObsMuteChanged extends Node {
  static readonly kind = 'obs_mute_changed';

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @valueOut('input', 'String') inputOut = (): string => this._out().input;
  @valueOut('muted', 'Bool') mutedOut = (): boolean => this._out().muted;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload as MutePayload | undefined;
    if (payload === undefined) {
      this.event.emit(undefined);
      return;
    }
    const cfg = (this.config ?? {}) as { onlyInput?: string };
    const want = (cfg.onlyInput ?? '').trim();
    if (want && want !== payload.input) return;
    this.setState({
      input: payload.input,
      muted: payload.muted,
    } satisfies MuteOut);
    this.event.emit(undefined);
  }

  private _out(): MuteOut {
    return this.getState<MuteOut>() ?? EMPTY;
  }
}
