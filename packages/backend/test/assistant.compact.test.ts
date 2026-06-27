import { describe, it, expect } from 'vitest';
import { compactToolHistory } from '../src/assistant/agent.js';
import type { ChatMessage } from '../src/assistant/llm.js';

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
