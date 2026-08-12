import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, eventOut, valueOut } from '@vspark/shared/node_decorators';

/**
 * Payload delivered into the `event` input port by the {@link HotkeyManager}
 * when a matching system-wide key combination is pressed on the machine running
 * the server.
 */
export interface HotkeyEventPayload {
  /** The key name that fired, as reported by the OS hook (e.g. `F8`, `A`). */
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

interface HotkeyState {
  key: string;
}

const EMPTY: HotkeyState = { key: '' };

/**
 * System-wide keyboard shortcut trigger. A backend `HotkeyManager` installs a
 * global OS keyboard hook and fires this node's `event` port whenever the
 * configured key (+ modifiers) is pressed — even when vspark is not the focused
 * window. The combo is read from the node's config (`key` / `ctrl` / `shift` /
 * `alt` / `meta`), so the manager can match an incoming keystroke against every
 * hotkey node in every running graph without pulling the node's value inputs.
 *
 * Mirrors the overlive event-node shape: the body of `onEvent` records what
 * fired into state and re-emits a bare `event` trigger; the value outputs read
 * from state.
 */
@SignalNode({
  label: 'System Hotkey',
  description:
    'Fires when a system-wide keyboard shortcut is pressed on the machine running the server (works even when vspark is not focused). Set the key name (e.g. F8, A, SPACE) and any modifiers.',
  tags: ['input'],
  color: '#3b9c6e',
})
export class SystemHotkey extends Node {
  static readonly kind = 'system_hotkey';

  // Combo config — editable inline on the node card; the HotkeyManager reads
  // these straight off the node's defaultConfig to decide whether a keystroke
  // matches (events arrive externally, so the node never pulls these itself).
  @valueIn('key', 'String') keyIn!: () => string | undefined;
  @valueIn('ctrl', 'Bool') ctrlIn!: () => boolean | undefined;
  @valueIn('shift', 'Bool') shiftIn!: () => boolean | undefined;
  @valueIn('alt', 'Bool') altIn!: () => boolean | undefined;
  @valueIn('meta', 'Bool') metaIn!: () => boolean | undefined;

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @valueOut('key', 'String') key = (): string => this._out().key;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload as HotkeyEventPayload | undefined;
    if (payload === undefined) {
      // External "probe" path (no payload) — emit without touching state.
      this.event.emit(undefined);
      return;
    }
    this.setState({ key: payload.key } satisfies HotkeyState);
    this.event.emit(undefined);
  }

  private _out(): HotkeyState {
    return this.getState<HotkeyState>() ?? EMPTY;
  }
}
