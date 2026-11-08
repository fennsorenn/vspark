import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkEvent } from '@vspark/shared/signal';
import { inferRegex, regexGroups } from '@vspark/shared/infer_nodes';
import { RT } from '@vspark/shared/signal_types';
import { buildGraph, pullValue } from './helpers/nodeHarness.js';

/**
 * The pure helper nodes of the Actions plan, phase 1: regex, if_else, equals,
 * chat_rank, text_format, logic_id. All but if_else are value-only, so they're
 * read through `pullValue` (config supplies the unconnected inputs).
 */
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

describe('regexGroups', () => {
  it('numbers capture groups by index and names the named ones', () => {
    expect(
      regexGroups('(?<a>x)(y)(?:z)(?=w)(?<=q)(?<!r)[(]\\((?<b>v)')
    ).toEqual([
      { index: 1, name: 'a', port: 'a' },
      { index: 2, name: null, port: 'group2' },
      { index: 3, name: 'b', port: 'b' },
    ]);
  });

  it('returns null for a pattern that does not compile', () => {
    expect(regexGroups('(unclosed')).toBeNull();
    expect(regexGroups('a', 'q')).toBeNull(); // invalid flag
  });

  it('never lets a group shadow the fixed outputs', () => {
    expect(regexGroups('(?<matched>a)(?<groups>b)').map((g) => g.port)).toEqual(
      ['group1', 'group2']
    );
  });
});

describe('inferRegex', () => {
  it('derives group outputs from a literal pattern', () => {
    const r = inferRegex(
      { resolvedInputs: {}, config: { pattern: '(?<user>\\w+) (\\d+)' } },
      []
    );
    expect(r.outputPorts.map((p) => p.name)).toEqual([
      'matched',
      'user',
      'group2',
      'groups',
    ]);
    expect(r.outputPorts.at(-1)!.type).toEqual(
      RT.record({ user: RT.primitive('String') })
    );
  });

  it('has no group outputs while the pattern is wired', () => {
    const r = inferRegex(
      {
        resolvedInputs: { pattern: RT.primitive('String') },
        config: { pattern: '(a)' },
      },
      []
    );
    expect(r.outputPorts.map((p) => p.name)).toEqual(['matched', 'groups']);
    expect(r.outputPorts[1].type).toEqual(RT.unknown());
  });
});

describe('regex', () => {
  const quote = {
    pattern: '"(?<quote>[^"]+)" - (?<character>[^.]+)\\. (\\d{4})',
    text: '"I\'ll be back" - The Terminator. 1984',
  };

  it('outputs matched + one string per capture group', () => {
    expect(pullValue('regex', 'matched', quote)).toBe(true);
    expect(pullValue('regex', 'quote', quote)).toBe("I'll be back");
    expect(pullValue('regex', 'character', quote)).toBe('The Terminator');
    expect(pullValue('regex', 'group3', quote)).toBe('1984');
  });

  it('outputs the named groups as a record', () => {
    expect(pullValue('regex', 'groups', quote)).toEqual({
      quote: "I'll be back",
      character: 'The Terminator',
    });
  });

  it('reads empty groups when the text does not match', () => {
    const cfg = { ...quote, text: 'nothing here' };
    expect(pullValue('regex', 'matched', cfg)).toBe(false);
    expect(pullValue('regex', 'quote', cfg)).toBe('');
    expect(pullValue('regex', 'groups', cfg)).toEqual({
      quote: '',
      character: '',
    });
  });

  it('applies flags, ignoring g/y', () => {
    expect(
      pullValue('regex', 'matched', {
        pattern: 'hello',
        flags: 'i',
        text: 'HeLLo',
      })
    ).toBe(true);
    expect(
      pullValue('regex', 'matched', {
        pattern: 'hello',
        flags: 'gy',
        text: 'HeLLo',
      })
    ).toBe(false);
  });

  it('never matches an empty pattern', () => {
    expect(pullValue('regex', 'matched', { pattern: '', text: 'x' })).toBe(
      false
    );
  });

  it('treats an invalid pattern as no match and logs it once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { graph } = buildGraph(
        [
          { id: 'n', kind: 'regex' },
          { id: 'trg', kind: 'component_trigger' },
          { id: 'sink', kind: 'log' },
        ],
        [
          {
            fromNodeId: 'n',
            fromPort: 'matched',
            toNodeId: 'sink',
            toPort: 'inputs',
          },
          {
            fromNodeId: 'n',
            fromPort: 'groups',
            toNodeId: 'sink',
            toPort: 'inputs',
          },
          {
            fromNodeId: 'trg',
            fromPort: 'trigger',
            toNodeId: 'sink',
            toPort: 'trigger',
          },
        ],
        { n: { pattern: '(oops', text: 'oops' } }
      );
      graph.fire('trg', 'trigger', mkEvent(undefined));
      graph.fire('trg', 'trigger', mkEvent(undefined));
      expect(graph.peekInput('sink', 'inputs')).toEqual([false, {}]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('if_else', () => {
  function build(condition: unknown) {
    const { graph } = buildGraph(
      [
        { id: 'g', kind: 'if_else' },
        { id: 't', kind: 'log' },
        { id: 'e', kind: 'log' },
      ],
      [
        { fromNodeId: 'g', fromPort: 'then', toNodeId: 't', toPort: 'trigger' },
        { fromNodeId: 'g', fromPort: 'else', toNodeId: 'e', toPort: 'trigger' },
      ],
      { g: { condition } }
    );
    graph.deliverExternal('g', 'in', mkEvent('payload'));
    const got = (id: string) =>
      (graph.peekInput(id, 'trigger') as { payload?: unknown } | undefined)
        ?.payload;
    return { then: got('t'), else: got('e') };
  }

  it('routes to then when the condition is true, payload unchanged', () => {
    expect(build(true)).toEqual({ then: 'payload', else: undefined });
  });

  it('routes to else otherwise (false, unset, non-boolean)', () => {
    expect(build(false)).toEqual({ then: undefined, else: 'payload' });
    expect(build(undefined)).toEqual({ then: undefined, else: 'payload' });
    expect(build('true')).toEqual({ then: undefined, else: 'payload' });
  });
});

describe('equals', () => {
  it('compares primitives strictly', () => {
    expect(pullValue('equals', 'equal', { a: 'x', b: 'x' })).toBe(true);
    expect(pullValue('equals', 'equal', { a: 'X', b: 'x' })).toBe(false);
    expect(pullValue('equals', 'equal', { a: 1, b: '1' })).toBe(false);
    expect(pullValue('equals', 'equal', {})).toBe(true);
  });

  it('compares records and arrays structurally', () => {
    expect(
      pullValue('equals', 'equal', { a: { x: [1, 2] }, b: { x: [1, 2] } })
    ).toBe(true);
    expect(
      pullValue('equals', 'equal', { a: { x: [1, 2] }, b: { x: [2, 1] } })
    ).toBe(false);
  });
});

describe('chat_rank', () => {
  const allowed = (cfg: Record<string, unknown>) =>
    pullValue('chat_rank', 'allowed', cfg);

  it('lets everyone through by default', () => {
    expect(allowed({})).toBe(true);
    expect(allowed({ minRank: 'everyone' })).toBe(true);
  });

  it('orders sub < mod < broadcaster', () => {
    expect(allowed({ minRank: 'sub' })).toBe(false);
    expect(allowed({ minRank: 'sub', isSub: true })).toBe(true);
    expect(allowed({ minRank: 'mod', isSub: true })).toBe(false);
    expect(allowed({ minRank: 'mod', isMod: true })).toBe(true);
    expect(allowed({ minRank: 'sub', isMod: true })).toBe(true);
    expect(allowed({ minRank: 'broadcaster', isMod: true })).toBe(false);
    expect(allowed({ minRank: 'Broadcaster', isBroadcaster: true })).toBe(true);
    expect(allowed({ minRank: 'mod', isBroadcaster: true })).toBe(true);
  });

  it('denies an unknown rank', () => {
    expect(allowed({ minRank: 'vip', isBroadcaster: true })).toBe(false);
  });
});

describe('text_format', () => {
  it('fills placeholders from labeled ports', () => {
    expect(
      pullValue('text_format', 'text', {
        template: 'Hi ${user}, count ${n}!',
        fields: ['user', 'n'],
        user: 'alice',
        n: 3,
      })
    ).toBe('Hi alice, count 3!');
  });

  it('fills placeholders from the values record, ports first', () => {
    expect(
      pullValue('text_format', 'text', {
        template: '${user}: "${quote}" ${missing}',
        fields: ['user'],
        user: 'port',
        values: { user: 'record', quote: 'hello' },
      })
    ).toBe('port: "hello" ');
  });

  it('falls back to the record when a declared port is empty', () => {
    expect(
      pullValue('text_format', 'text', {
        template: '${user}',
        fields: ['user'],
        values: { user: 'record' },
      })
    ).toBe('record');
  });

  it('takes the values record from a wired regex', () => {
    const { graph } = buildGraph(
      [
        { id: 're', kind: 'regex' },
        { id: 'fmt', kind: 'text_format' },
        { id: 'trg', kind: 'component_trigger' },
        { id: 'sink', kind: 'log' },
      ],
      [
        {
          fromNodeId: 're',
          fromPort: 'groups',
          toNodeId: 'fmt',
          toPort: 'values',
        },
        {
          fromNodeId: 'fmt',
          fromPort: 'text',
          toNodeId: 'sink',
          toPort: 'inputs',
        },
        {
          fromNodeId: 'trg',
          fromPort: 'trigger',
          toNodeId: 'sink',
          toPort: 'trigger',
        },
      ],
      {
        re: { pattern: '!so (?<who>\\w+)', text: '!so bob' },
        fmt: { template: 'Go follow ${who}' },
      }
    );
    graph.fire('trg', 'trigger', mkEvent(undefined));
    expect(graph.peekInput('sink', 'inputs')).toEqual(['Go follow bob']);
  });
});

describe('logic_id', () => {
  it('outputs the injected graph id', () => {
    expect(pullValue('logic_id', 'id', { _logicId: 'g-1' })).toBe('g-1');
    expect(pullValue('logic_id', 'id', {})).toBe('');
  });
});
