import { SignalNode } from '@vspark/shared/signal';
import type { Blendshapes, Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, eventOut, valueIn, valueOut } from '@vspark/shared/node_decorators';

interface VisemePassthroughConfig {
  sensitivity?: number;
  enabled?: boolean;
}

interface VisemeState {
  scaled: Blendshapes;
}

@SignalNode({
  label: 'Visemes → Blendshapes',
  description:
    'Scales all incoming viseme weights by a sensitivity multiplier. Clamped to [0, 1].',
  tags: ['lipsync'],
  color: '#4a7a5a',
})
export class VisemePassthrough extends Node {
  static readonly kind = 'viseme_passthrough';

  @valueIn('blendshapes', 'Blendshapes')
  blendshapesIn!: () => Blendshapes | undefined;

  @eventOut('out', 'Blendshapes') out!: Emitter<Blendshapes>;

  @valueOut('blendshapes', 'Blendshapes')
  blendshapesOut = (): Blendshapes | undefined =>
    this.getState<VisemeState>()?.scaled;

  @eventIn('visemes', 'Blendshapes')
  onVisemes(ev: Event<Blendshapes>): void {
    const cfg = (this.config ?? {}) as VisemePassthroughConfig;
    const sensitivity = cfg.sensitivity ?? 1.0;
    const bs = ev?.payload ?? this.blendshapesIn();
    if (!bs) return;

    const scaled = bs.map((w) => Math.min(1, Math.max(0, w * sensitivity)));
    this.setState({ scaled } satisfies VisemeState);
    this.out.emit(scaled);
  }
}
