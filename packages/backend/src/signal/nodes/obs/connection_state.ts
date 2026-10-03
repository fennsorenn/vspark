import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, eventOut, valueOut } from '@vspark/shared/node_decorators';

interface StateOut {
  connected: boolean;
}

const EMPTY: StateOut = { connected: false };

interface StatePayload {
  connected: boolean;
}

/**
 * Fires when the project's obs-websocket connection comes up or goes down
 * (driven by ObsWsManager status transitions). Use it to react to OBS becoming
 * available/unavailable — e.g. show a "reconnecting" overlay. `connected`
 * output reflects the current link state.
 */
@SignalNode({
  label: 'OBS Connection State',
  description:
    'Fires when the OBS (obs-websocket) connection connects or disconnects. Outputs the current link state.',
  tags: ['obs'],
  color: '#3a3a5a',
})
export class ObsConnectionState extends Node {
  static readonly kind = 'obs_connection_state';

  @eventOut('connected', 'Trigger') connected!: Emitter<void>;
  @eventOut('disconnected', 'Trigger') disconnected!: Emitter<void>;

  @valueOut('isConnected', 'Bool') isConnectedOut = (): boolean =>
    this._out().connected;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload as StatePayload | undefined;
    if (payload === undefined) return;
    this.setState({ connected: payload.connected } satisfies StateOut);
    if (payload.connected) this.connected.emit(undefined);
    else this.disconnected.emit(undefined);
  }

  private _out(): StateOut {
    return this.getState<StateOut>() ?? EMPTY;
  }
}
