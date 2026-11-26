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
 * The producer slot is keyed by **(target avatar, expression)** — NOT by this
 * node — so that driving the same expression from a different node (e.g. the two
 * `set_expression` nodes behind a `cycle`/toggle: "Happy=1" on one output,
 * "Happy=0" on the other) writes the SAME slot and the LAST write wins. Keying
 * per-node instead made the bus SUM the two slots, so the "off" node's 0 never
 * cancelled the "on" node's 1 and the expression stuck on. Each instance tracks
 * the slots it published so `onUnbind` releases exactly those on teardown.
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

  /** Producer slot ids this instance has written to, for teardown cleanup. */
  private readonly _published = new Set<string>();

  /** Bus producer key: last-writer-wins per (target avatar, expression). */
  private _producerId(nodeId: string, expression: string): string {
    return `set_expression:${nodeId}:${expression}`;
  }

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const nodeId = this.nodeId();
    const expression = this.expression();
    if (!nodeId || !expression) return;
    const raw = this.weight();
    const weight = typeof raw === 'number' && Number.isFinite(raw) ? raw : 1;
    const producerId = this._producerId(nodeId, expression);
    this._published.add(producerId);
    broadcastBus.publishBlendshapes(
      nodeId,
      producerId,
      Blendshapes.fromRecord({ [expression]: weight })
    );
  }

  protected override onUnbind(): void {
    // Release exactly the slots we wrote so expressions don't linger after the
    // graph stops / reconciles (mirrors set_data clearing its data channels).
    for (const id of this._published) broadcastBus.removeBehavior(id);
    this._published.clear();
  }
}
