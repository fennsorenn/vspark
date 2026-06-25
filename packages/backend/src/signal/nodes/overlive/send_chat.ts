import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, eventOut } from '@vspark/shared/node_decorators';
import { getOverliveManager } from '../../../overlive/manager.js';

interface SendChatConfig {
  /** User-defined field NAMES (+ order). Each becomes a labeled value-in port
   *  whose current value is substituted for `${name}` in the template. The
   *  dynamic-port mechanism is shared with `set_data` via `inferSendChat`. */
  fields?: string[];
  /** Config fallback for the `template` port when unconnected. */
  template?: string;
  /** Config fallback for the `account` port when unconnected. */
  account?: string;
  /** Config fallback for the `channel` port when unconnected. */
  channel?: string;
}

/**
 * Sends a chat message to a live-stream account on `fire`. The message body is
 * a template string with `${field}` placeholders; each placeholder is replaced
 * with the current value of the like-named dynamic input port (the same dynamic
 * labeled-port mechanism `set_data` uses). Placeholders with no matching field
 * resolve to the empty string. After substitution, an empty/whitespace-only
 * message is skipped.
 *
 * Routing is delegated to `OverliveManager.sendChat`, which posts via the
 * account's adapter (Twitch today; requires the `user:write:chat` scope).
 */
@SignalNode({
  label: 'Overlive Send Chat',
  description:
    'Sends a chat message on fire. The template string interpolates ${field} placeholders from the node’s labeled input ports.',
  tags: ['overlive'],
  color: '#9146ff',
})
export class OverliveSendChat extends Node {
  static readonly kind = 'overlive_send_chat';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('channel', 'String') channel!: () => string | undefined;
  @valueIn('template', 'String') template!: () => string | undefined;

  @eventOut('sent', 'Trigger') sent!: Emitter<void>;

  private _fieldNames(): string[] {
    const cfg = (this.config ?? {}) as SendChatConfig;
    return (cfg.fields ?? []).filter((f) => f.length > 0);
  }

  /** Resolve the template (port → config fallback → '') and substitute each
   *  `${name}` with the current value of input `name`. Unknown names → ''. */
  private _render(): string {
    const cfg = (this.config ?? {}) as SendChatConfig;
    const tpl = this.template() ?? cfg.template ?? '';
    if (typeof tpl !== 'string' || tpl.length === 0) return '';
    const fields = new Set(this._fieldNames());
    return tpl.replace(/\$\{(\w+)\}/g, (_m, name: string) => {
      if (!fields.has(name)) return '';
      const v = this.input(name);
      return v === null || v === undefined ? '' : String(v);
    });
  }

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const text = this._render().trim();
    if (text.length === 0) return;
    const cfg = (this.config ?? {}) as SendChatConfig;
    const accountId = (this.account() as string | undefined) ?? cfg.account;
    if (typeof accountId !== 'string' || accountId.length === 0) return;
    const channel = this.channel() ?? cfg.channel;
    // Fire-and-forget; the manager swallows + logs send errors.
    void getOverliveManager().sendChat(accountId, channel, text);
    this.sent.emit(undefined);
  }
}
