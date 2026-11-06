/**
 * playbackWrites.test.ts — transport authored on the mesh (the tab's peer is
 * the store; helpers/mesh.ts gives each test one).
 *
 * Two properties worth pinning beyond "it writes something":
 *   - no transport write lands on the undo stack, or pressing Play makes the
 *     next Ctrl+Z un-pause instead of undoing the user's last edit;
 *   - a scrub is a gesture — the drag rides the lossy preview channel (an
 *     overlay over the committed document) and only the release commits.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { testPeer } from './helpers/mesh';
import * as w from '../src/mesh/playbackWrites';

const NOW = 1_700_000_000_000;
type Pb = {
  id: string;
  clipId: string;
  state: string;
  startEpoch: number | null;
  pausedAtT: number | null;
  speed: number;
  loop: boolean;
};
const col = () => testPeer().collection<Pb>('clip_playback');

function setup(state?: Partial<Pb>): void {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  if (state)
    col().put(
      {
        id: 'pb:c1',
        clipId: 'c1',
        state: 'stopped',
        startEpoch: null,
        pausedAtT: null,
        speed: 1,
        loop: false,
        ...state,
      },
      { v: { t: 1, c: 0, n: 'seed' } }
    );
}
const doc = () => col().get('pb:c1');
const committed = () => col().replica.raw('pb:c1');

describe('transport writes', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('play anchors at now', () => {
    setup();
    w.commitPlay('c1');
    expect(doc()).toMatchObject({
      clipId: 'c1',
      state: 'playing',
      startEpoch: NOW,
      pausedAtT: null,
    });
  });

  it('pause freezes at the current playhead', () => {
    setup({ state: 'playing', startEpoch: NOW - 2500 });
    w.commitPause('c1');
    expect(doc()).toMatchObject({ state: 'paused', pausedAtT: 2.5 });
  });

  it('resume re-anchors so the clip continues from where it froze', () => {
    setup({ state: 'paused', pausedAtT: 2.5 });
    w.commitResume('c1');
    expect(doc()).toMatchObject({
      state: 'playing',
      pausedAtT: null,
      startEpoch: NOW - 2500,
    });
  });

  it('stop clears both the anchor and the frozen value', () => {
    setup({ state: 'playing', startEpoch: NOW - 1000 });
    w.commitStop('c1');
    expect(doc()).toMatchObject({
      state: 'stopped',
      startEpoch: null,
      pausedAtT: null,
    });
  });

  it('seeking while playing keeps playing, re-anchored', () => {
    setup({ state: 'playing', startEpoch: NOW - 1000 });
    w.commitSeek('c1', 5);
    expect(doc()).toMatchObject({ state: 'playing', startEpoch: NOW - 5000 });
  });

  it('seeking while stopped parks the playhead paused at t', () => {
    setup({ state: 'stopped' });
    w.commitSeek('c1', 5);
    expect(doc()).toMatchObject({ state: 'paused', pausedAtT: 5 });
  });

  it('no transport write lands on the undo stack', () => {
    setup({ state: 'playing', startEpoch: NOW });
    w.commitPlay('c1');
    w.commitPause('c1');
    w.commitResume('c1');
    w.commitSeek('c1', 1);
    w.commitStop('c1');
    expect(testPeer().canUndo()).toBe(false);
  });

  it('a scrub overlays the document without committing; the release commits', () => {
    setup({ state: 'playing', startEpoch: NOW });
    w.previewSeek('c1', 3);
    expect(doc()).toMatchObject({ state: 'paused', pausedAtT: 3 }); // what shows
    expect(committed()).toMatchObject({ state: 'playing', startEpoch: NOW });
    expect(doc()?.clipId).toBe('c1'); // per-field overlays, never a root one

    w.commitSeek('c1', 3);
    expect(committed()).toMatchObject({ state: 'paused', pausedAtT: 3 });
  });
});
