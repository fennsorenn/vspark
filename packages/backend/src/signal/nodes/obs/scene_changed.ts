import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, eventOut, valueOut } from '@vspark/shared/node_decorators';
import type { ObsEvent } from '@vspark/shared';

interface SceneOut {
  name: string;
  width: number;
  height: number;
}

const EMPTY: SceneOut = { name: '', width: 0, height: 0 };

type SceneChanged = Extract<ObsEvent, { type: 'scene_changed' }>;

/**
 * Fires when OBS switches its active program scene (the `obsSceneChanged`
 * browser event). Use `onlyScene` in config to fire only when a specific scene
 * becomes active. Outputs the new scene's name and canvas size.
 */
@SignalNode({
  label: 'OBS Scene Changed',
  description:
    "Fires when OBS's active program scene changes. Outputs the scene name and canvas dimensions.",
  tags: ['obs'],
  color: '#3a3a5a',
})
export class ObsSceneChanged extends Node {
  static readonly kind = 'obs_scene_changed';

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @valueOut('name', 'String') nameOut = (): string => this._out().name;
  @valueOut('width', 'Float') widthOut = (): number => this._out().width;
  @valueOut('height', 'Float') heightOut = (): number => this._out().height;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload as SceneChanged | undefined;
    // Probe path (undefined payload): re-emit without touching state.
    if (payload === undefined) {
      this.event.emit(undefined);
      return;
    }
    const cfg = (this.config ?? {}) as { onlyScene?: string };
    const want = (cfg.onlyScene ?? '').trim();
    if (want && want !== payload.name) return;
    this.setState({
      name: payload.name,
      width: payload.width ?? 0,
      height: payload.height ?? 0,
    } satisfies SceneOut);
    this.event.emit(undefined);
  }

  private _out(): SceneOut {
    return this.getState<SceneOut>() ?? EMPTY;
  }
}
