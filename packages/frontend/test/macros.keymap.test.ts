import { describe, it, expect } from 'vitest';
import {
  browserCodeToHotkeyKey,
  comboFromKeyboardEvent,
  formatCombo,
  isCompleteCombo,
} from '../src/components/editor/macros/keymap';

describe('browserCodeToHotkeyKey', () => {
  it('maps letters, digits, F-keys, and numpad by rule', () => {
    expect(browserCodeToHotkeyKey('KeyA')).toBe('A');
    expect(browserCodeToHotkeyKey('KeyZ')).toBe('Z');
    expect(browserCodeToHotkeyKey('Digit0')).toBe('0');
    expect(browserCodeToHotkeyKey('Digit9')).toBe('9');
    expect(browserCodeToHotkeyKey('F8')).toBe('F8');
    expect(browserCodeToHotkeyKey('F12')).toBe('F12');
    expect(browserCodeToHotkeyKey('Numpad5')).toBe('NUMPAD 5');
  });

  it('maps named keys to the global-hook names', () => {
    expect(browserCodeToHotkeyKey('Space')).toBe('SPACE');
    expect(browserCodeToHotkeyKey('Enter')).toBe('RETURN');
    expect(browserCodeToHotkeyKey('Escape')).toBe('ESCAPE');
    expect(browserCodeToHotkeyKey('ArrowUp')).toBe('UP ARROW');
    expect(browserCodeToHotkeyKey('Period')).toBe('DOT');
    expect(browserCodeToHotkeyKey('Slash')).toBe('FORWARD SLASH');
    expect(browserCodeToHotkeyKey('Backquote')).toBe('BACKTICK');
  });

  it('returns null for modifier-only and unmapped codes', () => {
    expect(browserCodeToHotkeyKey('ControlLeft')).toBeNull();
    expect(browserCodeToHotkeyKey('ShiftRight')).toBeNull();
    expect(browserCodeToHotkeyKey('MetaLeft')).toBeNull();
    expect(browserCodeToHotkeyKey('Unidentified')).toBeNull();
  });
});

describe('comboFromKeyboardEvent', () => {
  it('captures the key plus held modifiers', () => {
    expect(
      comboFromKeyboardEvent({
        code: 'KeyS',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
      })
    ).toEqual({ key: 'S', ctrl: true, shift: true, alt: false, meta: false });
  });

  it('returns null when only a modifier is pressed', () => {
    expect(
      comboFromKeyboardEvent({
        code: 'ControlLeft',
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      })
    ).toBeNull();
  });

  it('produces a key name the backend HotkeyManager matches (uppercased)', () => {
    // HotkeyManager compares cfg.key.toUpperCase() to the hook's e.name — our
    // captured key is already in that namespace.
    const combo = comboFromKeyboardEvent({
      code: 'F8',
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    })!;
    expect(combo.key).toBe('F8');
    expect(combo.key.toUpperCase()).toBe(combo.key);
  });
});

describe('formatCombo / isCompleteCombo', () => {
  it('formats modifiers in a stable order with a title-cased key', () => {
    expect(
      formatCombo({ key: 'F8', ctrl: true, shift: true, alt: false, meta: false })
    ).toBe('Ctrl + Shift + F8');
    expect(
      formatCombo({ key: 'UP ARROW', ctrl: false, shift: false, alt: true, meta: false })
    ).toBe('Alt + Up Arrow');
    expect(
      formatCombo({ key: 'A', ctrl: false, shift: false, alt: false, meta: false })
    ).toBe('A');
  });

  it('isCompleteCombo requires a real key', () => {
    expect(isCompleteCombo({ key: 'A', ctrl: false, shift: false, alt: false, meta: false })).toBe(true);
    expect(isCompleteCombo({ key: '', ctrl: true, shift: false, alt: false, meta: false })).toBe(false);
  });
});
