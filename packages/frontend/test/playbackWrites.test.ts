/**
 * playbackWrites.test.ts — transport authored on the mesh.
 *
 * Two properties worth pinning beyond "it writes something":
 *   - every transport write carries `undo: false`, or pressing Play makes the
 *     next Ctrl+Z un-pause instead of undoing the user's last edit;
 *   - a scrub is a gesture — the drag rides the lossy preview channel and only
 *     the release commits, one overlay per field.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface SetCall {
  id: string;
  path: string;
  value: unknown;
  opts?: { channel?: string; undo?: boolean };
}

const calls: SetCall[] = [];
let canWrite = true;
let held: Record<string, unknown> | undefined = { id: 'pb:c1' };

vi.mock('../src/mesh/peer', () => ({
  getMeshHandles: () => ({
    collections: {
      clip_playback: {
        canWrite: () => canWrite,
        get: () => held,
        set: (id: string, path: string, value: unknown, opts?: object) =>
          calls.push({ id, path, value, opts }),
      },
    },
  }),
  initMeshPeer: () => Promise.resolve({ collections: {} }),
}));

const NOW = 1_700_000_000_000;

async function setup(state?: Record<string, unknown>) {
  calls.length = 0;
  canWrite = true;
  held = { id: 'pb:c1' };
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const { useEditorStore } = await import('../src/store/editorStore');
  useEditorStore.setState({
    clipPlayback: state
      ? {
          c1: {
            id: 'pb:c1',
            clipId: 'c1',
            state: 'stopped',
            startEpoch: null,
            pausedAtT: null,
            speed: 1,
            loop: false,
            ...state,
          } as never,
        }
      : {},
  });
  return import('../src/mesh/playbackWrites');
}

const lastDoc = () => calls[calls.length - 1].value as Record<string, unknown>;

describe('transport writes', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('play anchors at now and is not undoable', async () => {
    const w = await setup();
    w.commitPlay('c1');
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('pb:c1');
    expect(calls[0].path).toBe(''); // whole doc
    expect(calls[0].opts?.undo).toBe(false);
    expect(lastDoc()).toMatchObject({
      clipId: 'c1',
      state: 'playing',
      startEpoch: NOW,
      pausedAtT: null,
    });
  });

  it('pause freezes at the current playhead', async () => {
    const w = await setup({ state: 'playing', startEpoch: NOW - 2500 });
    w.commitPause('c1');
    expect(lastDoc()).toMatchObject({ state: 'paused', pausedAtT: 2.5 });
  });

  it('resume re-anchors so the clip continues from where it froze', async () => {
    const w = await setup({ state: 'paused', pausedAtT: 2.5 });
    w.commitResume('c1');
    const doc = lastDoc();
    expect(doc.state).toBe('playing');
    expect(doc.pausedAtT).toBeNull();
    expect(doc.startEpoch).toBe(NOW - 2500);
  });

  it('stop clears both the anchor and the frozen value', async () => {
    const w = await setup({ state: 'playing', startEpoch: NOW - 1000 });
    w.commitStop('c1');
    expect(lastDoc()).toMatchObject({
      state: 'stopped',
      startEpoch: null,
      pausedAtT: null,
    });
  });

  it('seeking while playing keeps playing, re-anchored', async () => {
    const w = await setup({ state: 'playing', startEpoch: NOW - 1000 });
    w.commitSeek('c1', 5);
    const doc = lastDoc();
    expect(doc.state).toBe('playing');
    expect(doc.startEpoch).toBe(NOW - 5000);
  });

  it('seeking while stopped parks the playhead paused at t', async () => {
    const w = await setup({ state: 'stopped' });
    w.commitSeek('c1', 5);
    expect(lastDoc()).toMatchObject({ state: 'paused', pausedAtT: 5 });
  });

  it('every transport write opts out of undo', async () => {
    const w = await setup({ state: 'playing', startEpoch: NOW });
    w.commitPlay('c1');
    w.commitPause('c1');
    w.commitResume('c1');
    w.commitSeek('c1', 1);
    w.commitStop('c1');
    expect(calls).toHaveLength(5);
    for (const c of calls) expect(c.opts?.undo).toBe(false);
  });

  it('a scrub previews per field on the lossy channel, never as a root overlay', async () => {
    const w = await setup({ state: 'playing', startEpoch: NOW });
    w.previewSeek('c1', 3);
    expect(calls.length).toBeGreaterThan(1); // one per field, not one whole doc
    for (const c of calls) {
      expect(c.opts?.channel).toBe('preview');
      expect(c.path).not.toBe(''); // a root overlay would blank the doc
    }
    expect(calls.map((c) => c.path).sort()).toEqual([
      'pausedAtT',
      'startEpoch',
      'state',
    ]);
  });

  it('a scrub writes nothing committed — only the release does', async () => {
    const w = await setup({ state: 'playing', startEpoch: NOW });
    w.previewSeek('c1', 3);
    expect(calls.every((c) => c.opts?.channel === 'preview')).toBe(true);

    calls.length = 0;
    w.commitSeek('c1', 3);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts?.channel).toBeUndefined(); // committed channel
  });

  it('falls back to a local apply when the peer cannot author', async () => {
    // Nothing persists and nothing fans out, but the transport still responds —
    // which matters for the window before the peer arms, and for a viewer
    // running without one.
    const w = await setup();
    const { useEditorStore } = await import('../src/store/editorStore');
    canWrite = false;
    w.commitPlay('c1');
    expect(calls).toHaveLength(0);
    expect(useEditorStore.getState().clipPlayback.c1).toMatchObject({
      clipId: 'c1',
      state: 'playing',
    });
  });
});
