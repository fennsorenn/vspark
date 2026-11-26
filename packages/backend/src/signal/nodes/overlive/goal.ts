import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, valueOut, eventOut } from '@vspark/shared/node_decorators';
import type { GoalEvent } from '@overlive/core';
import { getOverliveManager } from '../../../overlive/manager.js';
import { acctOrDefault } from './_actions.js';

interface GoalOut {
  goalId: string;
  kind: string;
  description: string;
  current: number;
  target: number;
  /** 0–1. */
  progress: number;
  /** Running (begin / progress / fetched); false once it ended. */
  active: boolean;
  achieved: boolean;
}

const EMPTY: GoalOut = {
  goalId: '',
  kind: '',
  description: '',
  current: 0,
  target: 0,
  progress: 0,
  active: false,
  achieved: false,
};

/**
 * A creator goal of the account (Twitch; scope `channel:read:goals`). Fires
 * when a goal begins, progresses or ends, and with the goal's current state
 * when the graph starts, the account connects, or `refresh` fires (fetched
 * from the platform — see `OverliveManager.refreshGoals`). Set `kind` to
 * follow one kind of goal (follow, subscription, subscription_count,
 * new_subscription, new_subscription_count, new_bit, new_cheerer); empty takes
 * any.
 */
@SignalNode({
  label: 'Overlive Goal',
  description:
    'A creator goal of the account (Twitch): fires when it begins, progresses or ends, and with its current state when the graph starts. "kind" picks one kind of goal; empty takes any.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveGoal extends Node {
  static readonly kind = 'overlive_goal';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('channel', 'String') channel!: () => string | undefined;
  @valueIn('kind', 'String') goalKind!: () => unknown;

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @valueOut('description', 'String') description = (): string => this._out().description;
  @valueOut('current', 'Float') current = (): number => this._out().current;
  @valueOut('target', 'Float') target = (): number => this._out().target;
  @valueOut('progress', 'Float') progress = (): number => this._out().progress;
  @valueOut('active', 'Bool') active = (): boolean => this._out().active;
  @valueOut('achieved', 'Bool') achieved = (): boolean => this._out().achieved;
  @valueOut('kind', 'String') kindOut = (): string => this._out().kind;
  @valueOut('data', 'Any') data = (): GoalOut => ({ ...this._out() });

  private boot: ReturnType<typeof setTimeout> | null = null;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload as GoalEvent | undefined;
    if (payload === undefined) return;
    const d = payload.data;
    const want = typeof this.goalKind() === 'string' ? String(this.goalKind()).trim() : '';
    if (want !== '' && d.kind !== want) return;
    // A goal other than the one shown ending doesn't clear it.
    const cur = this._out();
    if (d.phase === 'end' && cur.active && cur.goalId !== '' && cur.goalId !== d.goalId) return;
    this.setState({
      goalId: d.goalId,
      kind: String(d.kind),
      description: d.description,
      current: d.current,
      target: d.target,
      progress: d.target > 0 ? Math.min(1, Math.max(0, d.current / d.target)) : 0,
      active: d.phase !== 'end',
      achieved: d.achieved,
    } satisfies GoalOut);
    this.event.emit(undefined);
  }

  /** Fetch the account's goals now; they arrive as events. */
  @eventIn('refresh', 'Trigger')
  onRefresh(): void {
    try {
      const accountId = acctOrDefault(
        this.account,
        this.config as { account?: string; _projectId?: unknown } | undefined
      );
      if (accountId) void getOverliveManager().refreshGoals(accountId);
    } catch {
      // No Overlive manager (early boot, tests): nothing to fetch from; the
      // account connecting fetches anyway.
    }
  }

  protected override onBind(): void {
    this.boot = setTimeout(() => {
      this.boot = null;
      this.onRefresh();
    }, 0);
  }

  protected override onUnbind(): void {
    if (this.boot !== null) clearTimeout(this.boot);
    this.boot = null;
  }

  private _out(): GoalOut {
    return this.getState<GoalOut>() ?? EMPTY;
  }
}
