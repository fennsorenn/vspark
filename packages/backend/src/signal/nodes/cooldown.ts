import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, eventOut, valueIn } from '@vspark/shared/node_decorators';
import {
  readVariable,
  variableRef,
  writeVariable,
} from '../../variables/store.js';

/** Variable scope the shared cooldown groups keep their "last passed" time
 *  in: one short-lived variable per group name, per project. */
export const COOLDOWN_SCOPE = '__cooldown';

interface CooldownState {
  /** Wall-clock ms of the last event that passed (private cooldown only). */
  last?: number;
}

/**
 * Rate limit: an `in` event passes on `out` unless one passed less than
 * `seconds` ago, in which case it goes out on `blocked` instead. Payloads pass
 * through unchanged (outputs mirror the input type, see `inferCooldown`).
 * Blocked events don't restart the cooldown.
 *
 * With `group` empty the cooldown is private to this node (scratch state, reset
 * when the graph restarts). With a group name, the "last passed" time is the
 * short-lived project variable `group` in scope `__cooldown`, so every cooldown
 * of the project with the same group shares one cooldown — across graphs. A
 * group needs a project; outside a Logic graph it behaves as private.
 *
 * `seconds` unset, zero or negative lets everything through. The node holds no
 * timers: it compares wall-clock times when an event arrives.
 */
@SignalNode({
  label: 'Cooldown',
  description:
    'Lets an event through at most once per cooldown period; events during the cooldown go out on "blocked". Give several cooldowns the same group name to share one cooldown.',
  tags: ['flow'],
  color: '#5a4a2a',
})
export class Cooldown extends Node {
  static readonly kind = 'cooldown';

  @valueIn('seconds', 'Float') seconds!: () => unknown;
  @valueIn('group', 'String') group!: () => unknown;

  @eventOut('out', 'Any') out!: Emitter<unknown>;
  @eventOut('blocked', 'Any') blocked!: Emitter<unknown>;

  @eventIn('in', 'Any')
  onIn(ev: Event<unknown>): void {
    const s = Number(this.seconds());
    const ms = Number.isFinite(s) && s > 0 ? s * 1000 : 0;
    const now = Date.now();
    const g = this.group();
    const ref =
      typeof g === 'string' && g.trim() !== ''
        ? variableRef(
            (this.config as { _projectId?: unknown })._projectId,
            COOLDOWN_SCOPE,
            g
          )
        : null;

    const stored = ref
      ? readVariable(ref)
      : this.getState<CooldownState | undefined>()?.last;
    const last = typeof stored === 'number' ? stored : undefined;

    // `now < last` (the clock moved back) counts as elapsed, not as blocked
    // until the clock catches up.
    if (last !== undefined && now >= last && now - last < ms) {
      this.blocked.emit(ev?.payload);
      return;
    }
    if (ref) writeVariable(ref, now, false);
    else this.setState({ last: now } satisfies CooldownState);
    this.out.emit(ev?.payload);
  }
}
