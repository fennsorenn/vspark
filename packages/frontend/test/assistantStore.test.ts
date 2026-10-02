import { describe, it, expect, beforeEach } from 'vitest';
import { useAssistantStore } from '../src/store/assistantStore';

const reset = () =>
  useAssistantStore.setState({
    open: false,
    streaming: false,
    entries: [],
    available: null,
  });

describe('assistantStore', () => {
  beforeEach(reset);

  it('toggles and sets open state', () => {
    useAssistantStore.getState().openAssistant();
    expect(useAssistantStore.getState().open).toBe(true);
    useAssistantStore.getState().toggleAssistant();
    expect(useAssistantStore.getState().open).toBe(false);
  });

  it('pushUser appends a user entry and marks streaming', () => {
    useAssistantStore.getState().pushUser('hello');
    const s = useAssistantStore.getState();
    expect(s.streaming).toBe(true);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ kind: 'user', text: 'hello' });
  });

  it('resolves a tool result onto the matching tool entry by id', () => {
    const st = useAssistantStore.getState();
    st.pushToolCall({ id: 't1', name: 'create_scene_node', args: { x: 1 } });
    st.resolveToolResult({ id: 't1', ok: true, text: '{"id":"n1"}' });
    const e = useAssistantStore.getState().entries.find((x) => x.id === 't1');
    expect(e).toMatchObject({ kind: 'tool', ok: true, result: '{"id":"n1"}' });
  });

  it('setStreaming(false) ends the turn; clear empties the transcript', () => {
    const st = useAssistantStore.getState();
    st.pushUser('hi');
    st.pushAssistantText('done');
    st.setStreaming(false);
    expect(useAssistantStore.getState().streaming).toBe(false);
    expect(useAssistantStore.getState().entries).toHaveLength(2);
    st.clear();
    expect(useAssistantStore.getState().entries).toHaveLength(0);
  });

  it('pushError records an error entry', () => {
    useAssistantStore.getState().pushError('boom');
    expect(useAssistantStore.getState().entries[0]).toMatchObject({
      kind: 'error',
      text: 'boom',
    });
  });
});
