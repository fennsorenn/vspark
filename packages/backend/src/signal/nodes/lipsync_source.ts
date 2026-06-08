import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventOut } from '@vspark/shared/node_decorators';
import type { Blendshapes } from '@vspark/shared/signal';

/**
 * Entry point for viseme weights pushed from the browser mic analyser. LipsyncManager
 * fires `visemes` directly via graph.fire() on each analysis frame; the node only
 * declares the output port.
 */
@SignalNode({
  label: 'Lipsync Source',
  description:
    'Entry point for viseme weights pushed from the browser mic analyser. Fired by LipsyncManager on each analysis frame.',
  tags: ["input"],
  color: '#4a7a5a',
  internal: true,
})
export class LipsyncSource extends Node {
  static readonly kind = 'lipsync_source';

  @eventOut('visemes', 'Blendshapes') visemes!: Emitter<Blendshapes>;
}
