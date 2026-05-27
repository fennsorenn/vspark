import {
  SignalNode,
  eventPort,
  valuePort,
  mkEvent,
} from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
  Blendshapes,
  Event,
} from '@vspark/shared/signal';

interface VisemePassthroughConfig {
  sensitivity?: number;
  enabled?: boolean;
}

@SignalNode({
  label: 'Viseme Passthrough',
  description:
    'Scales all incoming viseme weights by a sensitivity multiplier. Clamped to [0, 1].',
  tags: ['lipsync'],
  color: '#4a7a5a',
})
export class VisemePassthrough {
  static readonly kind = 'viseme_passthrough';
  static readonly inputPorts = [
    eventPort('visemes', 'Blendshapes'),
    valuePort('blendshapes', 'Blendshapes'),
  ] as const;
  static readonly outputPorts = [
    eventPort('out', 'Blendshapes'),
    valuePort('blendshapes', 'Blendshapes'),
  ] as const;

  static execute(
    inputs: InputsOf<typeof VisemePassthrough>,
    config: unknown,
    _ctx: NodeExecutionContext
  ): OutputsOf<typeof VisemePassthrough> {
    const cfg = (config ?? {}) as VisemePassthroughConfig;
    const sensitivity = cfg.sensitivity ?? 1.0;
    const evt = inputs.visemes as Event<Blendshapes> | undefined;
    const bs = evt?.payload ?? (inputs.blendshapes as Blendshapes | undefined);
    if (!bs) return {} as OutputsOf<typeof VisemePassthrough>;

    const scaled = bs.map((w) => Math.min(1, Math.max(0, w * sensitivity)));
    return {
      out: mkEvent(scaled, evt?.timestamp),
      blendshapes: scaled,
    };
  }
}
