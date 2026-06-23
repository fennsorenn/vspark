import { describe, it, expect } from 'vitest';
import { loneNode } from './helpers/nodeHarness.js';

/**
 * Overlive event nodes share a shape: an `@eventIn('event')` handler maps the
 * incoming provider payload's `.data` onto node state (applying any config
 * filters) and re-emits a bare `event` trigger. An `undefined` payload (the
 * external "probe" path) emits without touching state. Outputs read from state.
 */

describe('overlive_follow', () => {
  it('maps username/displayName from the payload', () => {
    const n = loneNode('overlive_follow');
    n.deliver('event', { data: { username: 'alice', displayName: 'Alice' } });
    expect(n.state()).toEqual({ username: 'alice', displayName: 'Alice' });
  });

  it('an undefined payload emits without setting state', () => {
    const n = loneNode('overlive_follow');
    n.deliver('event', undefined);
    expect(n.state()).toBeUndefined();
  });
});

describe('overlive_redemption', () => {
  const bits = {
    data: {
      username: 'bob',
      displayName: 'Bob',
      message: 'gg',
      currency: { kind: 'bits', amount: 100 },
    },
  };

  it('maps a bits redemption', () => {
    const n = loneNode('overlive_redemption');
    n.deliver('event', bits);
    expect(n.state()).toMatchObject({
      username: 'bob',
      currencyKind: 'bits',
      amount: 100,
      message: 'gg',
      rewardTitle: '',
      rewardId: '',
    });
  });

  it('filters by currencyKind — a non-matching kind is dropped', () => {
    const n = loneNode('overlive_redemption', { currencyKind: 'tip' });
    n.deliver('event', bits);
    expect(n.state()).toBeUndefined();
  });

  it('maps channel_points incl. reward fields and honours the rewardId filter', () => {
    const cp = {
      data: {
        username: 'cara',
        displayName: 'Cara',
        currency: {
          kind: 'channel_points',
          amount: 1,
          rewardTitle: 'Hydrate',
          rewardId: 'rw1',
        },
      },
    };
    const match = loneNode('overlive_redemption', {
      currencyKind: 'channel_points',
      rewardId: 'rw1',
    });
    match.deliver('event', cp);
    expect(match.state()).toMatchObject({ rewardTitle: 'Hydrate', rewardId: 'rw1' });

    const mismatch = loneNode('overlive_redemption', { rewardId: 'other' });
    mismatch.deliver('event', cp);
    expect(mismatch.state()).toBeUndefined();
  });
});

describe('overlive_chat_command', () => {
  const cmd = {
    data: {
      username: 'dan',
      displayName: 'Dan',
      command: 'Dance',
      args: ['fast', 'now'],
      text: '!dance fast now',
      isMod: true,
      isSub: false,
      isBroadcaster: false,
    },
  };

  it('maps the command, space-joining args', () => {
    const n = loneNode('overlive_chat_command');
    n.deliver('event', cmd);
    expect(n.state()).toMatchObject({ command: 'Dance', args: 'fast now', isMod: true });
  });

  it('filters case-insensitively by command name', () => {
    const match = loneNode('overlive_chat_command', { command: 'dance' });
    match.deliver('event', cmd);
    expect(match.state()).toMatchObject({ command: 'Dance' });

    const mismatch = loneNode('overlive_chat_command', { command: 'jump' });
    mismatch.deliver('event', cmd);
    expect(mismatch.state()).toBeUndefined();
  });
});
