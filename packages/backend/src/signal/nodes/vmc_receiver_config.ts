import { SignalNode, valuePort } from '@vspark/shared/signal'
import type { NodeExecutionContext, OutputsOf } from '@vspark/shared/signal'

export interface VmcReceiverConfigValues {
  host:   string
  port:   number
  mirror: boolean
}

/**
 * Exposes the VMC receiver component's user-facing config as individual typed
 * value ports — one port per key. Downstream nodes connect to the specific
 * port they care about rather than receiving the whole config blob.
 */
@SignalNode({
  label:    'VMC Receiver Config',
  tags:     ['context'],
  color:    '#2a2a4a',
  internal: true,
})
export class VmcReceiverConfig {
  static readonly kind        = 'vmc_receiver_config'
  static readonly inputPorts  = [] as const
  static readonly outputPorts = [
    valuePort('host',   'String'),
    valuePort('port',   'Float'),
    valuePort('mirror', 'Bool'),
  ] as const

  static execute(
    _: Record<string, never>,
    config: VmcReceiverConfigValues,
    _ctx: NodeExecutionContext,
  ): OutputsOf<typeof VmcReceiverConfig> {
    return {
      host:   config.host   ?? '0.0.0.0',
      port:   config.port   ?? 39539,
      mirror: config.mirror ?? false,
    }
  }
}
