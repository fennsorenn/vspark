import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, eventOut } from '@vspark/shared/node_decorators';
import { getOverliveManager } from '../../../overlive/manager.js';
import { acct, strOf, numOf, splitList } from './_actions.js';

/**
 * Create a poll on `fire`. `choices` is a comma/newline-separated list (2–5).
 * Set `pointsPerVote` > 0 to enable Channel-Points voting. Requires
 * `channel:manage:polls`.
 */
@SignalNode({
  label: 'Overlive Create Poll',
  description: 'Starts a poll on fire. Choices are comma-separated; pointsPerVote > 0 enables Channel-Points voting.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverlivePollCreate extends Node {
  static readonly kind = 'overlive_poll_create';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('title', 'String') title!: () => string | undefined;
  @valueIn('choices', 'String') choices!: () => string | undefined;
  @valueIn('seconds', 'Float') seconds!: () => number | undefined;
  @valueIn('pointsPerVote', 'Float') pointsPerVote!: () => number | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const cfg = (this.config ?? {}) as { title?: string; choices?: string; seconds?: number; pointsPerVote?: number };
    const seconds = numOf(this.seconds, cfg.seconds);
    if (seconds === undefined) return;
    void getOverliveManager().createPoll(
      accountId,
      strOf(this.title, cfg.title),
      splitList(strOf(this.choices, cfg.choices)),
      seconds,
      numOf(this.pointsPerVote, cfg.pointsPerVote)
    );
    this.done.emit(undefined);
  }
}

/** End a poll on `fire`. `status` is `TERMINATED` (default, shows result) or `ARCHIVED`. */
@SignalNode({
  label: 'Overlive End Poll',
  description: 'Ends a poll by id on fire (status: TERMINATED to show result, or ARCHIVED).',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverlivePollEnd extends Node {
  static readonly kind = 'overlive_poll_end';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('pollId', 'String') pollId!: () => string | undefined;
  @valueIn('status', 'String') status!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const cfg = (this.config ?? {}) as { pollId?: string; status?: string };
    const pollId = strOf(this.pollId, cfg.pollId);
    if (!pollId) return;
    void getOverliveManager().endPoll(accountId, pollId, strOf(this.status, cfg.status) || 'TERMINATED');
    this.done.emit(undefined);
  }
}

/**
 * Create a prediction on `fire`. `outcomes` is a comma/newline-separated list
 * (2–10). Requires `channel:manage:predictions`.
 */
@SignalNode({
  label: 'Overlive Create Prediction',
  description: 'Starts a prediction on fire. Outcomes are comma-separated; window is in seconds.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverlivePredictionCreate extends Node {
  static readonly kind = 'overlive_prediction_create';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('title', 'String') title!: () => string | undefined;
  @valueIn('outcomes', 'String') outcomes!: () => string | undefined;
  @valueIn('seconds', 'Float') seconds!: () => number | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const cfg = (this.config ?? {}) as { title?: string; outcomes?: string; seconds?: number };
    const seconds = numOf(this.seconds, cfg.seconds);
    if (seconds === undefined) return;
    void getOverliveManager().createPrediction(
      accountId,
      strOf(this.title, cfg.title),
      splitList(strOf(this.outcomes, cfg.outcomes)),
      seconds
    );
    this.done.emit(undefined);
  }
}

/**
 * End a prediction on `fire`. `status` is `RESOLVED` (needs `winningOutcomeId`),
 * `CANCELED`, or `LOCKED`. Requires `channel:manage:predictions`.
 */
@SignalNode({
  label: 'Overlive End Prediction',
  description: 'Resolves / cancels / locks a prediction on fire (RESOLVED needs winningOutcomeId).',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverlivePredictionEnd extends Node {
  static readonly kind = 'overlive_prediction_end';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('predictionId', 'String') predictionId!: () => string | undefined;
  @valueIn('status', 'String') status!: () => string | undefined;
  @valueIn('winningOutcomeId', 'String') winningOutcomeId!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const cfg = (this.config ?? {}) as { predictionId?: string; status?: string; winningOutcomeId?: string };
    const predictionId = strOf(this.predictionId, cfg.predictionId);
    if (!predictionId) return;
    void getOverliveManager().endPrediction(
      accountId,
      predictionId,
      strOf(this.status, cfg.status) || 'RESOLVED',
      strOf(this.winningOutcomeId, cfg.winningOutcomeId) || undefined
    );
    this.done.emit(undefined);
  }
}

/** Start a raid to another channel on `fire`. Requires `channel:manage:raids`. */
@SignalNode({
  label: 'Overlive Start Raid',
  description: 'Starts a raid to another channel (target = broadcaster user id) on fire.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveRaidStart extends Node {
  static readonly kind = 'overlive_raid_start';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('target', 'String') target!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const cfg = (this.config ?? {}) as { target?: string };
    const target = strOf(this.target, cfg.target);
    if (!target) return;
    void getOverliveManager().startRaid(accountId, target);
    this.done.emit(undefined);
  }
}

/** Cancel a pending raid on `fire`. Requires `channel:manage:raids`. */
@SignalNode({
  label: 'Overlive Cancel Raid',
  description: 'Cancels a pending raid on fire.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveRaidCancel extends Node {
  static readonly kind = 'overlive_raid_cancel';

  @valueIn('account', 'Account') account!: () => unknown;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    void getOverliveManager().cancelRaid(accountId);
    this.done.emit(undefined);
  }
}
