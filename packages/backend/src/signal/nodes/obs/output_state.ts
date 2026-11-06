import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, eventOut, valueOut } from '@vspark/shared/node_decorators';
import type { ObsEvent } from '@vspark/shared';

interface OutputStateOut {
  output: string;
  state: string;
  active: boolean;
}

const EMPTY: OutputStateOut = { output: '', state: '', active: false };

type OutputStateEvent = Extract<ObsEvent, { type: 'output_state' }>;

/**
 * Fires when an OBS output's run-state changes — streaming, recording, replay
 * buffer, or virtual camera — folded into one event with an `output`
 * discriminator. Use `onlyOutput` to restrict to a single output. `state`
 * carries the transition (started / stopped / paused / saved / …) and `active`
 * the resulting on/off state.
 */
@SignalNode({
  label: 'OBS Output State',
  description:
    'Fires on OBS streaming / recording / replay-buffer / virtualcam state changes. Outputs which output changed, the transition, and whether it is now active.',
  tags: ['obs'],
  color: '#3a3a5a',
})
export class ObsOutputState extends Node {
  static readonly kind = 'obs_output_state';

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @valueOut('output', 'String') outputOut = (): string => this._out().output;
  @valueOut('state', 'String') stateOut = (): string => this._out().state;
  @valueOut('active', 'Bool') activeOut = (): boolean => this._out().active;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload as OutputStateEvent | undefined;
    if (payload === undefined) {
      this.event.emit(undefined);
      return;
    }
    const cfg = (this.config ?? {}) as { onlyOutput?: string };
    const want = (cfg.onlyOutput ?? '').trim();
    if (want && want !== payload.output) return;
    this.setState({
      output: payload.output,
      state: payload.state,
      active: payload.active,
    } satisfies OutputStateOut);
    this.event.emit(undefined);
  }

  private _out(): OutputStateOut {
    return this.getState<OutputStateOut>() ?? EMPTY;
  }
}
