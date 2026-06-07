import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { valueIn, eventOut } from '@vspark/shared/node_decorators';
import type { BoneRotations, Blendshapes } from '@vspark/shared/signal';

/**
 * Entry point for VMC/RhyLive UDP data. The VmcManager fires the `bones` and `arkit`
 * outputs directly via `graph.fire(nodeId, port, mkEvent(...))` for each packet — there
 * is no reaction here, the node just declares the output ports (and host/port value
 * inputs the manager reads from config to bind its socket).
 */
@SignalNode({
  label: 'VMC Packet Source',
  description:
    'Receives UDP packets from a VMC-compatible app. Fires bone and ARKit data as events.',
  tags: ["input"],
  color: '#1a3a5a',
})
export class VmcPacketSource extends Node {
  static readonly kind = 'vmc_packet_source';

  @valueIn('host', 'String') host!: () => string | undefined;
  @valueIn('port', 'Float') port!: () => number | undefined;

  @eventOut('bones', 'BoneRotations') bones!: Emitter<BoneRotations>;
  @eventOut('arkit', 'ArkitBlendshapes') arkit!: Emitter<Blendshapes>;
}
