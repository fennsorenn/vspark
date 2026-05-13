import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal'
import type { OutputsOf } from '@vspark/shared/signal'

@SignalNode({
  label:       'VMC Packet Source',
  description: 'Receives UDP packets from a VMC-compatible app. Fires bone and ARKit data as events.',
  tags:        ['input', 'mocap'],
  color:       '#1a3a5a',
})
export class VmcPacketSource {
  static readonly kind        = 'vmc_packet_source'
  static readonly inputPorts  = [
    valuePort('host', 'String'),
    valuePort('port', 'Float'),
  ] as const
  static readonly outputPorts = [
    eventPort('bones', 'BoneRotations'),
    eventPort('arkit', 'ArkitBlendshapes'),
  ] as const

  // Manager fires events directly via graph.fire(); execute is not called in normal operation.
  static execute(): OutputsOf<typeof VmcPacketSource> {
    return {} as OutputsOf<typeof VmcPacketSource>
  }
}
