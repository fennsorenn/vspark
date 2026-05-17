import { SignalNode, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'

interface SineWaveConfig {
  /** Oscillations per second. Default 0.25 (one breath every 4 s). */
  frequency?: number
  /** Peak output magnitude in radians. Default 0.05. */
  amplitude?: number
  /** Phase offset in radians. Default 0. */
  phase?: number
}

@SignalNode({
  label:       'Sine Wave',
  description: 'Outputs sin(time × frequency × 2π + phase) × amplitude. Connect a Clock time output as the trigger/time source.',
  tags:        ['math'],
  color:       '#4a7a5a',
})
export class SineWave {
  static readonly kind        = 'sine_wave'
  static readonly inputPorts  = [
    valuePort('time',      'Float'),
    valuePort('frequency', 'Float'),
    valuePort('amplitude', 'Float'),
    valuePort('phase',     'Float'),
  ] as const
  static readonly outputPorts = [
    valuePort('value', 'Float'),
  ] as const

  static execute(
    inputs:  InputsOf<typeof SineWave>,
    config:  unknown,
    _ctx:    NodeExecutionContext,
  ): OutputsOf<typeof SineWave> {
    const cfg = config as SineWaveConfig | null
    const time      = (inputs.time      as number | undefined) ?? 0
    const frequency = (inputs.frequency as number | undefined) ?? cfg?.frequency ?? 0.25
    const amplitude = (inputs.amplitude as number | undefined) ?? cfg?.amplitude ?? 0.05
    const phase     = (inputs.phase     as number | undefined) ?? cfg?.phase     ?? 0
    const value = Math.sin(time * frequency * 2 * Math.PI + phase) * amplitude
    return { value }
  }
}
