import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';

@SignalNode({
  label: 'Sine Wave',
  description:
    'Outputs sin(time × frequency × 2π + phase) × amplitude. Connect a Clock time output as the trigger/time source.',
  tags: ["math"],
  color: '#4a7a5a',
})
export class SineWave extends Node {
  static readonly kind = 'sine_wave';

  @valueIn('time', 'Float') time!: () => number | undefined;
  @valueIn('frequency', 'Float') frequency!: () => number | undefined;
  @valueIn('amplitude', 'Float') amplitude!: () => number | undefined;
  @valueIn('phase', 'Float') phase!: () => number | undefined;

  @valueOut('value', 'Float')
  value = (): number => {
    const time = this.time() ?? 0;
    const frequency = this.frequency() ?? 0.25;
    const amplitude = this.amplitude() ?? 0.05;
    const phase = this.phase() ?? 0;
    return Math.sin(time * frequency * 2 * Math.PI + phase) * amplitude;
  };
}
