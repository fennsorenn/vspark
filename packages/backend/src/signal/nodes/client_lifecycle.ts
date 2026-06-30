import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, eventOut, valueOut } from '@vspark/shared/node_decorators';

interface LifecycleOut {
  target: string;
  count: number;
}

const EMPTY: LifecycleOut = { target: '', count: 0 };

interface LifecyclePayload {
  phase: 'connected' | 'disconnected';
  target: string;
  count: number;
}

/**
 * Fires when a render client (a browser tab or OBS browser source showing a
 * vspark scene) connects or disconnects. Each client announces a stable
 * `target` marker on connect (a compose-scene id or an `?obsTarget=` URL
 * param); set `onlyTarget` in config to react to just one. `count` outputs the
 * project's live render-client total after the change.
 *
 * This is vspark-native (not OBS-specific) — it works for a plain browser tab
 * too — but is driven by the same browser-source bridge (ObsManager) that owns
 * per-socket identity. See dev-notes/modules/obs.md.
 */
@SignalNode({
  label: 'Client Lifecycle',
  description:
    'Fires when a render client (browser tab / OBS browser source) connects or disconnects. Outputs the client target marker and live client count.',
  tags: ['input'],
  color: '#4a7a5a',
})
export class ClientLifecycle extends Node {
  static readonly kind = 'client_lifecycle';

  @eventOut('connected', 'Trigger') connected!: Emitter<void>;
  @eventOut('disconnected', 'Trigger') disconnected!: Emitter<void>;

  @valueOut('target', 'String') targetOut = (): string => this._out().target;
  @valueOut('count', 'Float') countOut = (): number => this._out().count;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload as LifecyclePayload | undefined;
    if (payload === undefined) return;
    const cfg = (this.config ?? {}) as { onlyTarget?: string };
    const want = (cfg.onlyTarget ?? '').trim();
    if (want && want !== payload.target) return;
    this.setState({
      target: payload.target,
      count: payload.count,
    } satisfies LifecycleOut);
    if (payload.phase === 'connected') this.connected.emit(undefined);
    else this.disconnected.emit(undefined);
  }

  private _out(): LifecycleOut {
    return this.getState<LifecycleOut>() ?? EMPTY;
  }
}
