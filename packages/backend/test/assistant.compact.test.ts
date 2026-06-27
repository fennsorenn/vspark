import { describe, it, expect } from 'vitest';
import {
  compactToolHistory,
  pruneOldestGroups,
  sanitizeAssistantText,
} from '../src/assistant/agent.js';
import type { ChatMessage } from '../src/assistant/llm.js';

/** Assert every tool message has a preceding assistant tool_call with its id. */
function pairingIntact(msgs: ChatMessage[]): boolean {
  const ids = new Set<string>();
  for (const m of msgs)
    if (m.role === 'assistant' && m.tool_calls)
      for (const tc of m.tool_calls) ids.add(tc.id);
  return msgs
    .filter((m) => m.role === 'tool')
    .every((m) => ids.has(m.tool_call_id ?? ''));
}

/** Build a (assistant tool_call → tool result) pair. */
function round(id: string, name: string, result: string): ChatMessage[] {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: id, content: result },
  ];
}

describe('compactToolHistory', () => {
  it('keeps the most recent results verbatim and never drops messages', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    // 10 rounds, newest last
    for (let i = 0; i < 10; i++)
      msgs.push(...round(`c${i}`, 'create_scene_node', JSON.stringify({ id: `node-${i}`, extra: 'x'.repeat(500) })));
    const before = msgs.length;
    compactToolHistory(msgs);
    expect(msgs.length).toBe(before); // structure preserved

    const toolMsgs = msgs.filter((m) => m.role === 'tool');
    // last 8 untouched (still contain the bulky payload)
    for (const m of toolMsgs.slice(-8)) expect((m.content as string).length).toBeGreaterThan(400);
    // older ones collapsed to just their id ({"id":"node-N"})
    for (const m of toolMsgs.slice(0, -8)) {
      expect((m.content as string).length).toBeLessThan(40);
      expect(m.content).toContain('node-');
      expect(m.content).not.toContain('xxx'); // bulky payload gone
    }
  });

  it('preserves older list_*/lookup_* reference fetches (capped, not stubbed)', () => {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    // one old reference fetch, then 8 newer action rounds to push it out of the window
    msgs.push(...round('ref', 'list_node_kinds', 'k'.repeat(5000)));
    for (let i = 0; i < 8; i++) msgs.push(...round(`a${i}`, 'set_logic_descriptor', '{"ok":true}'));
    compactToolHistory(msgs);
    const ref = msgs.find((m) => m.tool_call_id === 'ref')!;
    // kept (still long, not collapsed to a stub) but capped with an ellipsis
    expect((ref.content as string).length).toBeGreaterThan(1000);
    expect(ref.content).toMatch(/…$/);
  });

  it('stubs stale action tool-call arguments but keeps recent + reference ones', () => {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    // old action call with a huge descriptor argument
    msgs.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'old', type: 'function', function: { name: 'set_logic_descriptor', arguments: JSON.stringify({ descriptor: 'z'.repeat(2000) }) } },
      ],
    });
    msgs.push({ role: 'tool', tool_call_id: 'old', content: '{"ok":true}' });
    // 14 filler messages so the old call is well outside KEEP_LAST_MESSAGES
    for (let i = 0; i < 7; i++) msgs.push(...round(`f${i}`, 'list_scenes', '{}'));
    compactToolHistory(msgs);
    const old = msgs.find((m) => m.role === 'assistant' && m.tool_calls?.[0].id === 'old')!;
    expect(old.tool_calls![0].function.arguments).toBe('{}'); // descriptor dropped
  });

  it('hard-caps total size by dropping oldest groups, preserving pairing + system', () => {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    // 40 fat rounds — far over the char budget
    for (let i = 0; i < 40; i++)
      msgs.push(...round(`c${i}`, 'create_scene_node', JSON.stringify({ id: `n${i}`, blob: 'z'.repeat(2000) })));
    compactToolHistory(msgs);
    const size = msgs.reduce((s, m) => s + JSON.stringify(m).length, 0);
    expect(size).toBeLessThanOrEqual(24000);
    expect(msgs[0].role).toBe('system'); // system kept
    expect(pairingIntact(msgs)).toBe(true); // no dangling tool messages
    expect(msgs.length).toBeLessThan(82); // groups were dropped
  });

  it('pruneOldestGroups drops to roughly the target length', () => {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 20; i++) msgs.push(...round(`c${i}`, 'create_scene_node', '{"id":"x"}'));
    pruneOldestGroups(msgs, 16);
    expect(msgs.length).toBeLessThanOrEqual(16 + 2 * 0 + 12); // bounded by target + protected tail
    expect(pairingIntact(msgs)).toBe(true);
  });

  it('is idempotent', () => {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 12; i++)
      msgs.push(...round(`c${i}`, 'update_scene_node', JSON.stringify({ ok: true, blob: 'y'.repeat(300) })));
    compactToolHistory(msgs);
    const snapshot = JSON.stringify(msgs);
    compactToolHistory(msgs);
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });
});

describe('sanitizeAssistantText', () => {
  it('cuts a leaked channel marker and trims', () => {
    expect(
      sanitizeAssistantText('I highlighted that for you.  <|channel>thought <channel|>')
    ).toBe('I highlighted that for you.');
  });
  it('cuts at harmony/turn control tokens', () => {
    expect(sanitizeAssistantText('Done<end_of_turn>')).toBe('Done');
    expect(sanitizeAssistantText('hello <|message|> internal')).toBe('hello');
  });
  it('leaves normal prose untouched', () => {
    const s = "I added a bloom effect to your camera. It's set to intensity 1.5.";
    expect(sanitizeAssistantText(s)).toBe(s);
  });
  it('strips a stray pipe token without a control word', () => {
    expect(sanitizeAssistantText('foo <|x|> bar').replace(/\s+/g, ' ')).toBe('foo bar');
  });
});
