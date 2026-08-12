import { describe, it, expect } from 'vitest';
import { loneNode } from './helpers/nodeHarness.js';
import { nodeMatches } from '../src/hotkeys/manager.js';
import type { HotkeyEventPayload } from '../src/signal/nodes/system_hotkey.js';

const press = (over: Partial<HotkeyEventPayload> = {}): HotkeyEventPayload => ({
  key: 'F8',
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
  ...over,
});

describe('system_hotkey node', () => {
  it('records the fired key into state and emits a trigger', () => {
    const n = loneNode('system_hotkey');
    n.deliver('event', press({ key: 'A', ctrl: true }));
    expect(n.state()).toEqual({ key: 'A' });
  });

  it('an undefined payload (probe) emits without touching state', () => {
    const n = loneNode('system_hotkey');
    n.deliver('event', undefined);
    expect(n.state()).toBeUndefined();
  });
});

describe('hotkey node matching', () => {
  it('matches an exact key + modifier combo (case-insensitive key)', () => {
    expect(nodeMatches({ key: 'f8' }, press())).toBe(true);
    expect(nodeMatches({ key: 'S', ctrl: true }, press({ key: 'S', ctrl: true }))).toBe(true);
  });

  it('requires an exact modifier match', () => {
    // Ctrl+S config does not fire on Ctrl+Shift+S.
    expect(
      nodeMatches({ key: 'S', ctrl: true }, press({ key: 'S', ctrl: true, shift: true }))
    ).toBe(false);
    // A bare-key config does not fire when a modifier is held.
    expect(nodeMatches({ key: 'F8' }, press({ ctrl: true }))).toBe(false);
  });

  it('does not match a different key', () => {
    expect(nodeMatches({ key: 'F8' }, press({ key: 'F9' }))).toBe(false);
  });

  it('an empty / missing key config never matches', () => {
    expect(nodeMatches({ key: '' }, press({ key: '' }))).toBe(false);
    expect(nodeMatches({}, press())).toBe(false);
  });
});
