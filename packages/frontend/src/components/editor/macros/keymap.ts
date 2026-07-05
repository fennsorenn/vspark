/**
 * Shortcut recorder keymap — translate a browser `KeyboardEvent` into the key
 * NAME that the server-side global keyboard hook (`node-global-key-listener`,
 * consumed by the backend HotkeyManager) reports.
 *
 * The recorder captures keystrokes in the browser (`KeyboardEvent.code` =
 * "KeyA" / "F8" / "Digit1" …), but matching happens server-side where the hook
 * uses names like "A" / "F8" / "1" / "SPACE" / "UP ARROW". This static table is
 * the bridge; it's applied when a recorded combo is saved into a `system_hotkey`
 * node's config. Names match `IGlobalKey` in node-global-key-listener.
 */

import type { HotkeyCombo } from './types.js';

/** Codes that are modifiers only — never the "main" key of a combo. */
const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

/** Fixed browser-code → global-hook-name entries (letters/digits/F-keys handled by rule). */
const CODE_TO_NAME: Record<string, string> = {
  Space: 'SPACE',
  Enter: 'RETURN',
  NumpadEnter: 'NUMPAD RETURN',
  Escape: 'ESCAPE',
  Backspace: 'BACKSPACE',
  Tab: 'TAB',
  Delete: 'DELETE',
  Insert: 'INS',
  PrintScreen: 'PRINT SCREEN',
  ArrowUp: 'UP ARROW',
  ArrowDown: 'DOWN ARROW',
  ArrowLeft: 'LEFT ARROW',
  ArrowRight: 'RIGHT ARROW',
  Home: 'HOME',
  End: 'END',
  PageUp: 'PAGE UP',
  PageDown: 'PAGE DOWN',
  Minus: 'MINUS',
  Equal: 'EQUALS',
  BracketLeft: 'SQUARE BRACKET OPEN',
  BracketRight: 'SQUARE BRACKET CLOSE',
  Semicolon: 'SEMICOLON',
  Quote: 'QUOTE',
  Backslash: 'BACKSLASH',
  Comma: 'COMMA',
  Period: 'DOT',
  Slash: 'FORWARD SLASH',
  Backquote: 'BACKTICK',
  NumpadDivide: 'NUMPAD DIVIDE',
  NumpadMultiply: 'NUMPAD MULTIPLY',
  NumpadSubtract: 'NUMPAD MINUS',
  NumpadAdd: 'NUMPAD PLUS',
  NumpadDecimal: 'NUMPAD DOT',
  NumpadEqual: 'NUMPAD EQUALS',
};

/**
 * Map one browser `KeyboardEvent.code` to the global-hook key name, or null for
 * a modifier-only / unmapped code (caller keeps recording).
 */
export function browserCodeToHotkeyKey(code: string): string | null {
  if (MODIFIER_CODES.has(code)) return null;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  const fkey = /^F([0-9]{1,2})$/.exec(code);
  if (fkey) return `F${fkey[1]}`;
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad) return `NUMPAD ${numpad[1]}`;
  return CODE_TO_NAME[code] ?? null;
}

/**
 * Build a {@link HotkeyCombo} from a keydown event. Returns null if the pressed
 * key is a modifier alone or an unmapped code — the recorder should ignore those
 * and keep waiting for a real key.
 */
export function comboFromKeyboardEvent(e: {
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): HotkeyCombo | null {
  const key = browserCodeToHotkeyKey(e.code);
  if (!key) return null;
  return {
    key,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey,
  };
}

/** True when the combo names a real key (a saveable macro shortcut). */
export function isCompleteCombo(combo: HotkeyCombo): boolean {
  return combo.key.trim().length > 0;
}

/** Human-readable shortcut label, e.g. "Ctrl + Shift + F8". Order: Ctrl, Alt, Shift, Meta, key. */
export function formatCombo(combo: HotkeyCombo): string {
  const parts: string[] = [];
  if (combo.ctrl) parts.push('Ctrl');
  if (combo.alt) parts.push('Alt');
  if (combo.shift) parts.push('Shift');
  if (combo.meta) parts.push('Meta');
  if (combo.key) parts.push(titleCaseKey(combo.key));
  return parts.join(' + ');
}

/** Pretty a hook key name for display: "UP ARROW" → "Up Arrow", "A" → "A". */
function titleCaseKey(key: string): string {
  return key
    .split(' ')
    .map((w) => (w.length <= 1 ? w : w[0] + w.slice(1).toLowerCase()))
    .join(' ');
}
