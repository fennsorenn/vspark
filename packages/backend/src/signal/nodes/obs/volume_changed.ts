import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, eventOut, valueOut } from '@vspark/shared/node_decorators';

interface VolumeOut {
  input: string;
  mul: number;
  db: number;
}

const EMPTY: VolumeOut = { input: '', mul: 0, db: 0 };

interface VolumePayload {
  input: string;
  mul: number;
  db: number;
}

/**
 * Fires when an OBS audio input's volume changes (obs-websocket
 * `InputVolumeChanged`) — e.g. someone moves a fader. Outputs the input name
 * and the new level as both linear multiplier and dB. Set `onlyInput` to react
 * to a single input. Needs an OBS connection for the project.
 */
@SignalNode({
  label: 'OBS Volume Changed',
  description:
    'Fires when an OBS audio input volume changes. Outputs input name, linear multiplier, and dB.',
  tags: ['obs'],
  color: '#3a3a5a',
})
export class ObsVolumeChanged extends Node {
  static readonly kind = 'obs_volume_changed';

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @valueOut('input', 'String') inputOut = (): string => this._out().input;
  @valueOut('mul', 'Float') mulOut = (): number => this._out().mul;
  @valueOut('db', 'Float') dbOut = (): number => this._out().db;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload as VolumePayload | undefined;
    if (payload === undefined) {
      this.event.emit(undefined);
      return;
    }
    const cfg = (this.config ?? {}) as { onlyInput?: string };
    const want = (cfg.onlyInput ?? '').trim();
    if (want && want !== payload.input) return;
    this.setState({
      input: payload.input,
      mul: payload.mul,
      db: payload.db,
    } satisfies VolumeOut);
    this.event.emit(undefined);
  }

  private _out(): VolumeOut {
    return this.getState<VolumeOut>() ?? EMPTY;
  }
}
