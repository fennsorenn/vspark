import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the OverliveManager singleton so the node's `getOverliveManager().sendChat`
// is observable and doesn't require a real DB/kit. Path resolves to the same
// module the node imports (`src/overlive/manager.js`).
const sendChat = vi.fn(async () => {});
vi.mock('../src/overlive/manager.js', () => ({
  getOverliveManager: () => ({ sendChat }),
  initOverliveManager: () => ({ sendChat }),
}));

import { loneNode } from './helpers/nodeHarness.js';

/**
 * `overlive_send_chat` renders a `${field}` template from its labeled input
 * ports (supplied here via config fallback) and forwards the result to
 * OverliveManager.sendChat on `fire`.
 */
describe('overlive_send_chat', () => {
  beforeEach(() => sendChat.mockClear());

  it('interpolates ${field} placeholders and sends', () => {
    const n = loneNode('overlive_send_chat', {
      account: 'acc-1',
      channel: 'mychan',
      template: 'Hi ${user}, you won ${amount}!',
      fields: ['user', 'amount'],
      user: 'alice',
      amount: 42,
    });
    n.deliver('fire', undefined);
    expect(sendChat).toHaveBeenCalledTimes(1);
    expect(sendChat).toHaveBeenCalledWith(
      'acc-1',
      'mychan',
      'Hi alice, you won 42!'
    );
  });

  it('renders missing/unknown fields as empty strings', () => {
    const n = loneNode('overlive_send_chat', {
      account: 'acc-1',
      template: 'Hello ${user}${unknown}',
      fields: ['user'],
      // `user` value omitted → empty; `unknown` not a declared field → empty
    });
    n.deliver('fire', undefined);
    expect(sendChat).toHaveBeenCalledWith('acc-1', undefined, 'Hello');
  });

  it('skips sending when the rendered message is empty', () => {
    const n = loneNode('overlive_send_chat', {
      account: 'acc-1',
      template: '${user}',
      fields: ['user'],
    });
    n.deliver('fire', undefined);
    expect(sendChat).not.toHaveBeenCalled();
  });

  it('skips sending when no account is configured', () => {
    const n = loneNode('overlive_send_chat', {
      template: 'hello',
    });
    n.deliver('fire', undefined);
    expect(sendChat).not.toHaveBeenCalled();
  });
});
