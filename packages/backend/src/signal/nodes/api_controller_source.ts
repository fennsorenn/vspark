import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventOut } from '@vspark/shared/node_decorators';
import type { Blendshapes } from '@vspark/shared/signal';

/**
 * Entry point for blendshape weights set over the API Controller's REST / MCP
 * surface. ApiControllerManager fires `blendshapes` directly via graph.fire()
 * on each set / clear; the node only declares the output port.
 */
@SignalNode({
  label: 'API Controller Source',
  description:
    'Entry point for blendshape weights set through the API Controller (REST / MCP). Fired by ApiControllerManager on each set or clear.',
  tags: ['input'],
  color: '#4a7a5a',
  internal: true,
})
export class ApiControllerSource extends Node {
  static readonly kind = 'api_controller_source';

  @eventOut('blendshapes', 'Blendshapes') blendshapes!: Emitter<Blendshapes>;
}
