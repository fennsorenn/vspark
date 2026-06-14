import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, valueOut, eventOut } from '@vspark/shared/node_decorators';
import type { ChatCommandEvent } from '@overlive/core';

interface ChatCommandOut {
  username: string;
  displayName: string;
  command: string;
  args: string;
  text: string;
  isMod: boolean;
  isSub: boolean;
  isBroadcaster: boolean;
}

const EMPTY: ChatCommandOut = {
  username: '',
  displayName: '',
  command: '',
  args: '',
  text: '',
  isMod: false,
  isSub: false,
  isBroadcaster: false,
};

/**
 * Chat commands — messages starting with the configured prefix (default `!`).
 * Use `command` to restrict to a specific command name (case-insensitive,
 * without the prefix). The `args` output is space-joined for convenience;
 * downstream nodes can split on whitespace.
 */
@SignalNode({
  label: 'Overlive Chat Command',
  description:
    'Fires when a chat message starts with the command prefix. Set "command" to filter to a single command name.',
  tags: ["overlive"],
  color: '#9146ff',
})
export class OverliveChatCommand extends Node {
  static readonly kind = 'overlive_chat_command';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('channel', 'String') channel!: () => string | undefined;
  @valueIn('command', 'String') command!: () => string | undefined; // '' = any

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @valueOut('username', 'String') username = (): string => this._out().username;
  @valueOut('displayName', 'String') displayName = (): string => this._out().displayName;
  @valueOut('command', 'String') commandOut = (): string => this._out().command;
  @valueOut('args', 'String') args = (): string => this._out().args; // space-joined
  @valueOut('text', 'String') text = (): string => this._out().text;
  @valueOut('isMod', 'Bool') isMod = (): boolean => this._out().isMod;
  @valueOut('isSub', 'Bool') isSub = (): boolean => this._out().isSub;
  @valueOut('isBroadcaster', 'Bool') isBroadcaster = (): boolean => this._out().isBroadcaster;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const cfg = (this.config ?? {}) as { command?: string };
    const wantCommand = (cfg.command ?? '').trim().toLowerCase();
    const payload = ev?.payload as ChatCommandEvent | undefined;
    if (payload === undefined) {
      this.event.emit(undefined);
      return;
    }
    if (wantCommand && payload.data.command.toLowerCase() !== wantCommand) return;

    this.setState({
      username: payload.data.username,
      displayName: payload.data.displayName,
      command: payload.data.command,
      args: payload.data.args.join(' '),
      text: payload.data.text,
      isMod: payload.data.isMod,
      isSub: payload.data.isSub,
      isBroadcaster: payload.data.isBroadcaster,
    } satisfies ChatCommandOut);
    this.event.emit(undefined);
  }

  private _out(): ChatCommandOut {
    return this.getState<ChatCommandOut>() ?? EMPTY;
  }
}
