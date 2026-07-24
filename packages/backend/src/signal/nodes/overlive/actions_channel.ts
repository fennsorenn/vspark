import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, eventOut } from '@vspark/shared/node_decorators';
import { getOverliveManager } from '../../../overlive/manager.js';
import { acct, strOf, numOf } from './_actions.js';

/**
 * Update channel metadata on `fire` — any of title / category / language.
 * Blank fields are left unchanged. Requires `channel:manage:broadcast`.
 */
@SignalNode({
  label: 'Overlive Update Channel',
  description: 'Updates stream title / category / language on fire. Blank fields are left unchanged.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveUpdateChannel extends Node {
  static readonly kind = 'overlive_update_channel';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('title', 'String') title!: () => string | undefined;
  @valueIn('category', 'String') category!: () => string | undefined;
  @valueIn('language', 'String') language!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const cfg = (this.config ?? {}) as { title?: string; category?: string; language?: string };
    void getOverliveManager().updateChannel(accountId, {
      title: strOf(this.title, cfg.title),
      categoryName: strOf(this.category, cfg.category),
      language: strOf(this.language, cfg.language),
    });
    this.done.emit(undefined);
  }
}

/**
 * Drop a stream marker at the current position on `fire`. Requires
 * `channel:manage:broadcast`.
 */
@SignalNode({
  label: 'Overlive Stream Marker',
  description: 'Creates a stream marker at the current position on fire (optional description).',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveStreamMarker extends Node {
  static readonly kind = 'overlive_stream_marker';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('description', 'String') description!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const cfg = (this.config ?? {}) as { description?: string };
    void getOverliveManager().createStreamMarker(accountId, strOf(this.description, cfg.description));
    this.done.emit(undefined);
  }
}

/**
 * Start a commercial of `seconds` length on `fire`. Requires
 * `channel:edit:commercial`.
 */
@SignalNode({
  label: 'Overlive Commercial',
  description: 'Starts a commercial of the given length (seconds) on fire.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveCommercial extends Node {
  static readonly kind = 'overlive_commercial';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('seconds', 'Float') seconds!: () => number | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    const cfg = (this.config ?? {}) as { seconds?: number };
    const seconds = numOf(this.seconds, cfg.seconds);
    if (seconds === undefined) return;
    void getOverliveManager().startCommercial(accountId, seconds);
    this.done.emit(undefined);
  }
}

/**
 * Snooze the next scheduled mid-roll ad on `fire`. Requires
 * `channel:manage:ads`.
 */
@SignalNode({
  label: 'Overlive Snooze Ad',
  description: 'Snoozes the next scheduled mid-roll ad on fire.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveSnoozeAd extends Node {
  static readonly kind = 'overlive_snooze_ad';

  @valueIn('account', 'Account') account!: () => unknown;
  @eventOut('done', 'Trigger') done!: Emitter<void>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const accountId = acct(this.account, (this.config as { account?: string } | undefined)?.account);
    if (!accountId) return;
    void getOverliveManager().snoozeAd(accountId);
    this.done.emit(undefined);
  }
}
