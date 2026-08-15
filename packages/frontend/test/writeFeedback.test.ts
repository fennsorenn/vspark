/**
 * A refused write has to say so.
 *
 * Every committed mesh write is optimistic — the value is on screen before the
 * authority has agreed to it — and a refusal makes the peer restore the
 * pre-write state. So a rejected edit LOOKS like the field spontaneously
 * reverting, which is indistinguishable from a bug in the editor.
 *
 * All three write shapes used to drop the outcome, each in its own way: the
 * bound-field path never read the ack at all, the create/delete helpers threw
 * into callers that swallowed it, and the REST fallback ended in
 * `.catch(() => {})`. These pin that a refusal now surfaces, and — just as
 * important — that an ACCEPTED write stays silent, since a toast per keystroke
 * would be worse than none.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WriteOutcome } from '@vspark/mesh';

vi.mock('../src/i18n', () => ({
  default: {
    // Render the key plus its interpolations, so a test can assert WHICH
    // message was raised without depending on the English copy.
    t: (key: string, opts?: Record<string, unknown>) =>
      `${key}|${opts?.subject ?? ''}|${opts?.reason ?? ''}`,
  },
}));

const rejected = (reason?: string): WriteOutcome =>
  ({ status: 'rejected', reason }) as WriteOutcome;

describe('write feedback', () => {
  beforeEach(async () => {
    vi.resetModules();
    const { useToastStore } = await import('../src/store/toastStore');
    useToastStore.getState().clear();
  });

  const toasts = async () => {
    const { useToastStore } = await import('../src/store/toastStore');
    return useToastStore.getState().toasts;
  };

  it('raises an error toast naming the reason the authority gave', async () => {
    const { settled } = await import('../src/mesh/writeFeedback');
    expect(settled(rejected('name required'), 'the node')).toBe(false);

    const [t] = await toasts();
    expect(t.kind).toBe('error');
    // The authority's own words are usually the only specific thing we can
    // tell the user, so they must reach the message.
    expect(t.message).toBe('write.rejectedWithReason|the node|name required');
  });

  it('falls back to a reason-less message when the refusal carries none', async () => {
    const { settled } = await import('../src/mesh/writeFeedback');
    settled(rejected(), 'the node');
    expect((await toasts())[0].message).toBe('write.rejected|the node|');
  });

  it('says nothing when the write is accepted', async () => {
    const { settled } = await import('../src/mesh/writeFeedback');
    expect(settled({ status: 'acked' }, 'the node')).toBe(true);
    expect(await toasts()).toEqual([]);
  });

  it('says nothing for an unguarded write', async () => {
    // Preview-channel writes are unguarded by construction — they can never be
    // refused, and a notice on one would fire throughout a drag.
    const { settled } = await import('../src/mesh/writeFeedback');
    expect(settled({ status: 'unguarded' }, 'the node')).toBe(true);
    expect(await toasts()).toEqual([]);
  });

  it('follows a fire-and-forget handle and reports only refusals', async () => {
    const { watch } = await import('../src/mesh/writeFeedback');
    watch(Promise.resolve({ status: 'acked' } as WriteOutcome), 'the node');
    watch(Promise.resolve(rejected('no grant')), 'the layer');
    await Promise.resolve();
    await Promise.resolve();

    const list = await toasts();
    expect(list).toHaveLength(1);
    expect(list[0].message).toBe('write.rejectedWithReason|the layer|no grant');
  });

  it('does not throw when the handle rejects', async () => {
    // A peer torn down mid-flight never resolves an outcome. That is not worth
    // shouting about — the reconnect path re-syncs the document — but it must
    // not become an unhandled rejection either.
    const { watch } = await import('../src/mesh/writeFeedback');
    watch(Promise.reject(new Error('gone')), 'the node');
    await Promise.resolve();
    await Promise.resolve();
    expect(await toasts()).toEqual([]);
  });

  it('names the subject per rtype, and falls back for an unknown one', async () => {
    const { actionLabel } = await import('../src/mesh/writeFeedback');
    // An rtype is an internal word; "scene_node" in a user-facing message
    // would be worse than saying nothing.
    expect(actionLabel('scene_node')).toContain('write.subject.scene_node');
    expect(actionLabel('nonsense')).toContain('write.subject.nonsense');
  });
});

describe('toast store', () => {
  beforeEach(async () => {
    vi.resetModules();
    const { useToastStore } = await import('../src/store/toastStore');
    useToastStore.getState().clear();
  });

  it('collapses an identical message instead of stacking it', async () => {
    const { useToastStore } = await import('../src/store/toastStore');
    // One failing gesture often produces several writes; the user learns
    // nothing from the third copy of the same sentence.
    useToastStore.getState().push('error', 'same');
    useToastStore.getState().push('error', 'same');
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('caps the stack so a failing loop cannot paper the screen', async () => {
    const { useToastStore } = await import('../src/store/toastStore');
    for (let i = 0; i < 10; i++)
      useToastStore.getState().push('error', `msg ${i}`);
    expect(useToastStore.getState().toasts).toHaveLength(4);
    // The newest survive: the oldest failure is the least useful one.
    expect(useToastStore.getState().toasts.at(-1)!.message).toBe('msg 9');
  });

  it('dismisses by id', async () => {
    const { useToastStore } = await import('../src/store/toastStore');
    const id = useToastStore.getState().push('error', 'a');
    useToastStore.getState().push('error', 'b');
    useToastStore.getState().dismiss(id);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      'b',
    ]);
  });

  it('auto-dismisses after its time is up', async () => {
    vi.useFakeTimers();
    const { useToastStore } = await import('../src/store/toastStore');
    useToastStore.getState().push('info', 'transient');
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    expect(useToastStore.getState().toasts).toEqual([]);
    vi.useRealTimers();
  });
});

// ── wiring ────────────────────────────────────────────────────────────────────

/**
 * The reporter working in isolation is not the property that matters — the
 * property is that the WRITE PATHS call it. The bound-field path is the one
 * worth pinning: it is the most common write in the app, it cannot await (a
 * control commits synchronously from the UI's side), and it was the path that
 * discarded its handle outright.
 */
describe('write paths report their refusals', () => {
  let outcome: WriteOutcome;

  beforeEach(() => {
    vi.resetModules();
    outcome = { status: 'acked' };

    vi.doMock('../src/mesh/peer', () => {
      const col = {
        canWrite: () => true,
        get: (id: string) => ({ id, name: 'N' }),
        set: () => ({ ack: Promise.resolve(outcome) }),
        update: () => ({ ack: Promise.resolve(outcome) }),
        remove: () => ({ ack: Promise.resolve(outcome) }),
      };
      return {
        getMeshHandles: () => ({
          peer: {},
          serverPeerId: 'server',
          collections: new Proxy({}, { get: () => col }),
        }),
        meshBatch: <T>(fn: () => T): T => fn(),
      };
    });
  });

  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const { useToastStore } = await import('../src/store/toastStore');
    return useToastStore.getState().toasts;
  };

  it('surfaces a refused field edit', async () => {
    outcome = { status: 'rejected', reason: 'guard said no' } as WriteOutcome;
    const { commitNodePath } = await import('../src/mesh/writes');
    const { useEditorStore } = await import('../src/store/editorStore');
    useEditorStore.setState({ nodes: [{ id: 'n1', name: 'N' } as never] });

    commitNodePath('n1', 'name', 'Renamed');

    const list = await settle();
    expect(list).toHaveLength(1);
    expect(list[0].message).toContain('guard said no');
  });

  it('stays silent when the field edit is accepted', async () => {
    // A toast per accepted keystroke-commit would be worse than none at all.
    const { commitNodePath } = await import('../src/mesh/writes');
    const { useEditorStore } = await import('../src/store/editorStore');
    useEditorStore.setState({ nodes: [{ id: 'n1', name: 'N' } as never] });

    commitNodePath('n1', 'name', 'Renamed');

    expect(await settle()).toEqual([]);
  });
});
