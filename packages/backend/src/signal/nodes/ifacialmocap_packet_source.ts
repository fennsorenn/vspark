import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { valueIn, eventOut } from '@vspark/shared/node_decorators';
import type { BoneRotations, Blendshapes } from '@vspark/shared/signal';

/**
 * Entry point for iFacialMocap UDP data. Like `vmc_packet_source` this node has
 * no reaction of its own — the IFacialMocapManager parses each datagram and
 * fires the `bones` / `arkit` outputs via `graph.fire(nodeId, port, mkEvent(...))`.
 * The value inputs mirror the settings the manager reads off the behavior config
 * so the wiring is visible in the graph editor.
 *
 * Difference to the VMC source: `deviceHost` is the *iOS device's* address, not
 * a local bind address — iFacialMocap only starts streaming once the receiver
 * has sent it a handshake, so the receiver has to know where the phone is.
 */
@SignalNode({
  label: 'iFacialMocap Packet Source',
  description:
    'Receives UDP packets from the iFacialMocap iOS app. Fires head/eye bone rotations and ARKit blendshapes as events.',
  tags: ['input'],
  color: '#1a3a5a',
})
export class IFacialMocapPacketSource extends Node {
  static readonly kind = 'ifacialmocap_packet_source';

  @valueIn('deviceHost', 'String') deviceHost!: () => string | undefined;
  @valueIn('port', 'Float') port!: () => number | undefined;
  @valueIn('invertPitch', 'Bool') invertPitch!: () => boolean | undefined;
  @valueIn('invertYaw', 'Bool') invertYaw!: () => boolean | undefined;
  @valueIn('invertRoll', 'Bool') invertRoll!: () => boolean | undefined;

  @eventOut('bones', 'BoneRotations') bones!: Emitter<BoneRotations>;
  @eventOut('arkit', 'ArkitBlendshapes') arkit!: Emitter<Blendshapes>;
}
