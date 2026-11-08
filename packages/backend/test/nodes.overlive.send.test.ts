import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the OverliveManager singleton so the node's `getOverliveManager().sendChat`
// is observable and doesn't require a real DB/kit. Path resolves to the same
// module the node imports (`src/overlive/manager.js`).
const sendChat = vi.fn(async () => {});
const getDefaultAccountId = vi.fn((projectId: string) =>
  projectId === 'p1' ? 'acc-default' : null
);
vi.mock('../src/overlive/manager.js', () => ({
  getOverliveManager: () => ({ sendChat, getDefaultAccountId }),
  initOverliveManager: () => ({ sendChat, getDefaultAccountId }),
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

  it('an empty account sends as the project default account', () => {
    loneNode('overlive_send_chat', { template: 'hi', _projectId: 'p1' }).deliver('fire', undefined);
    expect(sendChat).toHaveBeenCalledWith('acc-default', undefined, 'hi');
    // An empty account PORT value counts as empty too.
    loneNode('overlive_send_chat', { template: 'yo', account: '', _projectId: 'p1' }).deliver(
      'fire',
      undefined
    );
    expect(sendChat).toHaveBeenLastCalledWith('acc-default', undefined, 'yo');
    sendChat.mockClear();
    loneNode('overlive_send_chat', { template: 'hi', _projectId: 'p2' }).deliver('fire', undefined);
    expect(sendChat).not.toHaveBeenCalled();
  });

  it('skips sending when no account is configured', () => {
    const n = loneNode('overlive_send_chat', {
      template: 'hello',
    });
    n.deliver('fire', undefined);
    expect(sendChat).not.toHaveBeenCalled();
  });

  // The templating was extracted into signal/textTemplate.ts (shared with
  // text_format). This pins the rendered output to the pre-extraction
  // implementation, reproduced verbatim below, across the edge cases.
  it('renders exactly as before the template extraction', () => {
    const legacy = (
      tpl: string,
      fields: string[],
      values: Record<string, unknown>
    ) => {
      const declared = new Set(fields);
      return tpl.replace(/\$\{(\w+)\}/g, (_m, name: string) => {
        if (!declared.has(name)) return '';
        const v = values[name];
        return v === null || v === undefined ? '' : String(v);
      });
    };
    const cases: Array<[string, string[], Record<string, unknown>]> = [
      ['${a}${a} ${b}!', ['a', 'b'], { a: 1, b: true }],
      ['${ a } ${a-b} $a {a} $${a}', ['a'], { a: 'x' }],
      ['${a}${undeclared}', ['a'], { a: null, undeclared: 'nope' }],
      [
        '${obj} ${zero} ${empty}',
        ['obj', 'zero', 'empty'],
        { obj: { k: 1 }, zero: 0, empty: '' },
      ],
      ['line1\n${a}', ['a'], { a: 'two' }],
    ];
    for (const [template, fields, values] of cases) {
      sendChat.mockClear();
      const n = loneNode('overlive_send_chat', {
        account: 'acc-1',
        template,
        fields,
        ...values,
      });
      n.deliver('fire', undefined);
      const expected = legacy(template, fields, values).trim();
      if (expected.length === 0) expect(sendChat).not.toHaveBeenCalled();
      else expect(sendChat).toHaveBeenCalledWith('acc-1', undefined, expected);
    }
  });
});
