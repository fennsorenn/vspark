import { SignalNode, Blendshapes } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { broadcastBus } from '../../broadcast/bus.js';

/**
 * Sets a single VRM expression (blendshape) weight on an avatar at runtime.
 *
 * A thin, single-sink wrapper over the same broadcast-bus path `api_controller`
 * and `blendshapes_broadcast` already use: on `fire`, it publishes a one-entry
 * `Blendshapes` to the bus for the target scene node. The bus keeps a producer
 * slot per `(sceneNodeId, producerId)`, sums all slots (clamped to [0,1]) and
 * emits a merged frame each tick — so the weight is a **sticky override that
 * holds until this node fires again or the graph stops**. That latching pairs
 * naturally with the `cycle` node (press → weight, press again → 0/clear).
 *
 * The producer id is derived from this node's own graph id (`selfId`), so it
 * works in a standalone Logic graph with no behavior, stays unique per node
 * instance (two `set_expression` nodes sum rather than clobber), and is cleaned
 * up on graph teardown via `onUnbind`.
 */
@SignalNode({
  label: 'Set Expression',
  description:
    'Set a VRM expression weight on an avatar (0..1). Sticky until changed or the graph stops. Set weight 0 to clear.',
  tags: ['output'],
  color: '#7a3a6a',
})
export class SetExpression extends Node {
  static readonly kind = 'set_expression';

  @valueIn('nodeId', 'SceneNode') nodeId!: () => string | undefined;
  @valueIn('expression', 'String') expression!: () => string | undefined;
  @valueIn('weight', 'Float') weight!: () => number | undefined;

  private _producerId(): string {
    return `set_expression:${this.selfId}`;
  }

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const nodeId = this.nodeId();
    const expression = this.expression();
    if (!nodeId || !expression) return;
    const raw = this.weight();
    const weight = typeof raw === 'number' && Number.isFinite(raw) ? raw : 1;
    broadcastBus.publishBlendshapes(
      nodeId,
      this._producerId(),
      Blendshapes.fromRecord({ [expression]: weight })
    );
  }

  protected override onUnbind(): void {
    // Release our producer slot so the expression doesn't linger after the
    // graph stops / reconciles (mirrors set_data clearing its data channels).
    broadcastBus.removeBehavior(this._producerId());
  }
}
