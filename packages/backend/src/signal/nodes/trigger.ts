import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import {
  eventIn,
  eventOut,
  valueIn,
  valueOut,
} from '@vspark/shared/node_decorators';
import {
  triggerRouter,
  type TriggerEventPayload,
} from '../../triggers/router.js';

const nameOf = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Fires a named trigger into every running Logic graph of this project (see
 * triggers/router.ts), carrying `payload` — any value, e.g. a `pack_event`
 * record unpacked on the other side. The project is the `_projectId` that
 * LogicManager injects; outside a Logic graph, or with an empty name, nothing
 * is sent.
 */
@SignalNode({
  label: 'Send Trigger',
  description:
    'Fires a named trigger that every "On Trigger" node with the same name in this project receives, with an optional payload.',
  tags: ['flow'],
  color: '#7a4a3a',
})
export class SendTrigger extends Node {
  static readonly kind = 'send_trigger';

  @valueIn('name', 'String') name!: () => unknown;
  @valueIn('payload', 'Any') payload!: () => unknown;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const projectId = (this.config as { _projectId?: unknown })._projectId;
    const name = nameOf(this.name());
    if (typeof projectId !== 'string' || projectId === '' || name === '')
      return;
    triggerRouter.send(projectId, name, this.payload() ?? null);
  }
}

interface OnTriggerState {
  payload: unknown;
}

/**
 * Fires `event` when a `send_trigger` anywhere in this project sends a trigger
 * whose name equals this node's `name` (exact, surrounding spaces ignored; an
 * empty name never fires). `payload` holds the last received payload.
 *
 * The router delivers every trigger of the project to the external `event`
 * input; the name is checked here, so it may be wired.
 */
@SignalNode({
  label: 'On Trigger',
  description:
    'Fires when a "Send Trigger" node in this project sends a trigger with this name. Outputs the trigger’s payload.',
  tags: ['flow'],
  color: '#7a4a3a',
})
export class OnTrigger extends Node {
  static readonly kind = 'on_trigger';

  @valueIn('name', 'String') name!: () => unknown;

  @eventOut('event', 'Trigger') event!: Emitter<void>;
  @valueOut('payload', 'Any') payload = (): unknown =>
    this.getState<OnTriggerState | undefined>()?.payload;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const t = ev?.payload as TriggerEventPayload | undefined;
    if (!t || typeof t.name !== 'string') return;
    const want = nameOf(this.name());
    if (want === '' || t.name !== want) return;
    this.setState({ payload: t.payload } satisfies OnTriggerState);
    this.event.emit(undefined);
  }
}
