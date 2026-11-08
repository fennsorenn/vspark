import { describe, it, expect } from 'vitest';
import {
  inferCycle,
  inferIfElse,
  inferCooldown,
  inferRegex,
  inferTextFormat,
  regexFlags,
  regexGroups,
  inferForKind,
} from '../src/infer_nodes.js';
import { RT } from '../src/signal_types.js';
import type { InferCtx } from '../src/node.js';

const ctx = (over: Partial<InferCtx> = {}): InferCtx => ({
  resolvedInputs: {},
  config: {},
  ...over,
});
const names = (ports: { name: string }[]) => ports.map((p) => p.name);
const evF = RT.event(RT.primitive('Float'));

describe('inferCycle', () => {
  it('defaults to 2 outputs mirroring the in payload', () => {
    const r = inferCycle(ctx({ resolvedInputs: { in: evF } }));
    expect(names(r.outputPorts)).toEqual(['out0', 'out1']);
    expect(r.outputPorts.every((p) => p.type.kind === 'event')).toBe(true);
    expect(r.outputPorts[0].type).toEqual(evF);
    expect(names(r.inputPorts)).toEqual(['in']);
  });

  it('honours config.count >= 2, floors it, and clamps invalid values to 2', () => {
    expect(
      names(inferCycle(ctx({ config: { count: 4 } })).outputPorts)
    ).toEqual(['out0', 'out1', 'out2', 'out3']);
    expect(
      inferCycle(ctx({ config: { count: 3.9 } })).outputPorts
    ).toHaveLength(3);
    expect(inferCycle(ctx({ config: { count: 1 } })).outputPorts).toHaveLength(
      2
    );
    expect(
      inferCycle(ctx({ config: { count: 'x' } })).outputPorts
    ).toHaveLength(2);
  });

  it('uses Event<unknown> when in is unconnected or not an event', () => {
    expect(inferCycle(ctx()).outputPorts[0].type).toEqual(
      RT.event(RT.unknown())
    );
    expect(
      inferCycle(ctx({ resolvedInputs: { in: RT.primitive('Float') } }))
        .outputPorts[0].type
    ).toEqual(RT.event(RT.unknown()));
  });
});

describe('pass-through gates', () => {
  it('if_else: then/else mirror the in payload, condition is a Bool input', () => {
    const r = inferIfElse(ctx({ resolvedInputs: { in: evF } }));
    expect(names(r.inputPorts)).toEqual(['in', 'condition']);
    expect(r.inputPorts[1].type).toEqual(RT.primitive('Bool'));
    expect(names(r.outputPorts)).toEqual(['then', 'else']);
    expect(r.outputPorts.map((p) => p.type)).toEqual([evF, evF]);
  });

  it('if_else: unconnected in gives Event<unknown> outputs', () => {
    const r = inferIfElse(ctx());
    expect(r.outputPorts[0].type).toEqual(RT.event(RT.unknown()));
  });

  it('cooldown: out/blocked mirror the payload; seconds + group inputs', () => {
    const payload = RT.record({ a: RT.primitive('String') });
    const r = inferCooldown(ctx({ resolvedInputs: { in: RT.event(payload) } }));
    expect(names(r.inputPorts)).toEqual(['in', 'seconds', 'group']);
    expect(r.inputPorts[1].type).toEqual(RT.primitive('Float'));
    expect(r.inputPorts[2].type).toEqual(RT.primitive('String'));
    expect(names(r.outputPorts)).toEqual(['out', 'blocked']);
    expect(r.outputPorts[1].type).toEqual(RT.event(payload));
  });
});

describe('regexFlags', () => {
  it('drops g, y and whitespace and de-duplicates', () => {
    expect(regexFlags('gimy ')).toBe('im');
    expect(regexFlags('iii')).toBe('i');
  });
  it('returns empty for non-strings', () => {
    expect(regexFlags(undefined)).toBe('');
    expect(regexFlags(5)).toBe('');
  });
});

describe('regexGroups', () => {
  it('returns null for an invalid pattern or flags', () => {
    expect(regexGroups('(')).toBeNull();
    expect(regexGroups('a', 'q')).toBeNull();
  });

  it('names unnamed groups group<n> and keeps named group names', () => {
    expect(regexGroups('(a)(?<word>b)(c)')).toEqual([
      { index: 1, name: null, port: 'group1' },
      { index: 2, name: 'word', port: 'word' },
      { index: 3, name: null, port: 'group3' },
    ]);
  });

  it('does not count non-capturing groups, lookarounds, escapes or classes', () => {
    expect(regexGroups('(?:a)(?=b)(?!c)(?<=d)(?<!e)\\(x\\)[(]')).toEqual([]);
    expect(regexGroups('(?:a)(b)')).toEqual([
      { index: 1, name: null, port: 'group1' },
    ]);
  });

  it('a group named like a fixed output falls back to group<n>', () => {
    expect(regexGroups('(?<matched>a)(?<groups>b)')).toEqual([
      { index: 1, name: 'matched', port: 'group1' },
      { index: 2, name: 'groups', port: 'group2' },
    ]);
  });

  it('ignores flags g/y when compiling', () => {
    expect(regexGroups('(a)', 'gy')).toHaveLength(1);
  });
});

describe('inferRegex', () => {
  it('literal pattern: matched, one port per group, groups record of named groups', () => {
    const r = inferRegex(ctx({ config: { pattern: '(?<user>\\w+)-(\\d+)' } }));
    expect(names(r.inputPorts)).toEqual(['text', 'pattern', 'flags']);
    expect(names(r.outputPorts)).toEqual([
      'matched',
      'user',
      'group2',
      'groups',
    ]);
    expect(r.outputPorts[0].type).toEqual(RT.primitive('Bool'));
    expect(r.outputPorts[1].type).toEqual(RT.primitive('String'));
    expect(r.outputPorts[3].type).toEqual(
      RT.record({ user: RT.primitive('String') })
    );
  });

  it('a pattern without named groups still exposes an empty groups record', () => {
    const r = inferRegex(ctx({ config: { pattern: '(a)' } }));
    expect(names(r.outputPorts)).toEqual(['matched', 'group1', 'groups']);
    expect(r.outputPorts[2].type).toEqual(RT.record({}));
  });

  it('wired pattern or flags: no group ports, groups is unknown', () => {
    for (const wired of ['pattern', 'flags']) {
      const r = inferRegex(
        ctx({
          config: { pattern: '(a)' },
          resolvedInputs: { [wired]: RT.primitive('String') },
        })
      );
      expect(names(r.outputPorts)).toEqual(['matched', 'groups']);
      expect(r.outputPorts[1].type).toEqual(RT.unknown());
    }
  });

  it('empty or missing pattern: no group ports, groups unknown', () => {
    for (const config of [{}, { pattern: '' }, { pattern: 3 }]) {
      const r = inferRegex(ctx({ config }));
      expect(names(r.outputPorts)).toEqual(['matched', 'groups']);
      expect(r.outputPorts[1].type).toEqual(RT.unknown());
    }
  });

  it('invalid literal pattern: no group ports, groups is an empty record', () => {
    const r = inferRegex(ctx({ config: { pattern: '(' } }));
    expect(names(r.outputPorts)).toEqual(['matched', 'groups']);
    expect(r.outputPorts[1].type).toEqual(RT.record({}));
  });

  it('config.flags participate in compilation', () => {
    const r = inferRegex(ctx({ config: { pattern: '(a)', flags: 'q' } }));
    expect(names(r.outputPorts)).toEqual(['matched', 'groups']);
  });
});

describe('inferTextFormat', () => {
  it('template + values record, then field ports typed from wiring, then a slot', () => {
    const r = inferTextFormat(
      ctx({
        config: { fields: ['user', '', 'n'] },
        resolvedInputs: { n: RT.primitive('Float') },
      })
    );
    expect(names(r.inputPorts)).toEqual([
      'template',
      'values',
      'user',
      'n',
      '',
    ]);
    expect(r.inputPorts[0].type).toEqual(RT.primitive('String'));
    expect(r.inputPorts[1].type).toEqual(RT.record({}));
    expect(r.inputPorts[2].type).toEqual(RT.unknown());
    expect(r.inputPorts[3].type).toEqual(RT.primitive('Float'));
    expect(r.outputPorts).toEqual([
      { name: 'text', type: RT.primitive('String') },
    ]);
  });

  it('defaults to no fields', () => {
    expect(names(inferTextFormat(ctx()).inputPorts)).toEqual([
      'template',
      'values',
      '',
    ]);
  });
});

describe('registry', () => {
  it('registers the logic helper kinds', () => {
    expect(inferForKind('cycle')).toBe(inferCycle);
    expect(inferForKind('if_else')).toBe(inferIfElse);
    expect(inferForKind('cooldown')).toBe(inferCooldown);
    expect(inferForKind('regex')).toBe(inferRegex);
    expect(inferForKind('text_format')).toBe(inferTextFormat);
  });
});
