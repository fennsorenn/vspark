import { SignalNode } from '@vspark/shared/signal';
import type { Blendshapes, Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, eventOut, valueIn, valueOut } from '@vspark/shared/node_decorators';

interface VisemeState {
  scaled: Blendshapes;
}

@SignalNode({
  label: 'Visemes → Blendshapes',
  description:
    'Scales all incoming viseme weights by a sensitivity multiplier. Clamped to [0, 1].',
  tags: ["mocap"],
  color: '#4a7a5a',
})
export class VisemePassthrough extends Node {
  static readonly kind = 'viseme_passthrough';

  @valueIn('blendshapes', 'Blendshapes')
  blendshapesIn!: () => Blendshapes | undefined;

  /** Multiplier for every weight. Wired (the Lipsync template feeds it from
   *  the behavior's `sensitivity` setting) or inline; the engine falls back to
   *  `config.sensitivity`, so graphs that set it in config keep working. */
  @valueIn('sensitivity', 'Float')
  sensitivityIn!: () => number | null | undefined;

  @eventOut('out', 'Blendshapes') out!: Emitter<Blendshapes>;

  @valueOut('blendshapes', 'Blendshapes')
  blendshapesOut = (): Blendshapes | undefined =>
    this.getState<VisemeState>()?.scaled;

  @eventIn('visemes', 'Blendshapes')
  onVisemes(ev: Event<Blendshapes>): void {
    const raw = this.sensitivityIn();
    const sensitivity =
      typeof raw === 'number' && Number.isFinite(raw) ? raw : 1.0;
    const bs = ev?.payload ?? this.blendshapesIn();
    if (!bs) return;

    const scaled = bs.map((w) => Math.min(1, Math.max(0, w * sensitivity)));
    this.setState({ scaled } satisfies VisemeState);
    this.out.emit(scaled);
  }
}
