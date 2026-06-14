import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, eventOut, valueOut } from '@vspark/shared/node_decorators';

interface QueueState {
  items: unknown[];
}

/**
 * FIFO event queue. `enqueue` appends a payload; `pop` shifts the oldest and emits it
 * on `popped`. `size` exposes the current depth as a pull value. The `popped` payload
 * type mirrors `enqueue`'s resolved payload (see inferQueueEvents in infer_nodes.ts),
 * so queued records survive the round-trip with their field shapes intact.
 *
 * State (the FIFO array) lives behind getState/setState so it survives reconcile().
 */
@SignalNode({
  label: 'Queue Events',
  description:
    'Buffer events FIFO. Enqueue to append, pop to release the oldest. Transparent to payload type.',
  tags: ["utility"],
  color: '#3a3a5a',
})
export class QueueEvents extends Node {
  static readonly kind = 'queue_events';

  @eventOut('popped', 'Any') popped!: Emitter<unknown>;

  @valueOut('size', 'Float')
  size = (): number => this._items().length;

  @eventIn('enqueue', 'Any')
  onEnqueue(ev: Event<unknown>): void {
    const items = this._items();
    this.setState({ items: [...items, ev?.payload ?? null] } satisfies QueueState);
  }

  @eventIn('pop', 'Trigger')
  onPop(): void {
    const items = this._items();
    if (items.length === 0) return;
    const [head, ...rest] = items;
    this.setState({ items: rest } satisfies QueueState);
    this.popped.emit(head);
  }

  private _items(): unknown[] {
    return this.getState<QueueState>()?.items ?? [];
  }
}
