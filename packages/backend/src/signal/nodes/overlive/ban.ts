import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, valueOut, eventOut } from '@vspark/shared/node_decorators';
import type { BanEvent } from '@overlive/core';

interface BanOut {
  username: string;
  displayName: string;
  moderatorName: string;
  reason: string;
  timeoutSeconds: number;
  isPermanent: boolean;
}

const EMPTY: BanOut = {
  username: '',
  displayName: '',
  moderatorName: '',
  reason: '',
  timeoutSeconds: 0,
  isPermanent: false,
};

@SignalNode({
  label: 'Overlive Ban',
  description: 'Fires on bans and timeouts. timeoutSeconds = 0 when permanent.',
  tags: ["overlive"],
  color: '#9146ff',
})
export class OverliveBan extends Node {
  static readonly kind = 'overlive_ban';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('channel', 'String') channel!: () => string | undefined;

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @valueOut('username', 'String') username = (): string => this._out().username;
  @valueOut('displayName', 'String') displayName = (): string => this._out().displayName;
  @valueOut('moderatorName', 'String') moderatorName = (): string => this._out().moderatorName;
  @valueOut('reason', 'String') reason = (): string => this._out().reason;
  @valueOut('timeoutSeconds', 'Float') timeoutSeconds = (): number => this._out().timeoutSeconds;
  @valueOut('isPermanent', 'Bool') isPermanent = (): boolean => this._out().isPermanent;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload as BanEvent | undefined;
    if (payload === undefined) {
      this.event.emit(undefined);
      return;
    }
    this.setState({
      username: payload.data.username,
      displayName: payload.data.displayName,
      moderatorName: payload.data.moderator?.username ?? '',
      reason: payload.data.reason ?? '',
      timeoutSeconds: payload.data.timeoutSeconds ?? 0,
      isPermanent: payload.data.isPermanent,
    } satisfies BanOut);
    this.event.emit(undefined);
  }

  private _out(): BanOut {
    return this.getState<BanOut>() ?? EMPTY;
  }
}
