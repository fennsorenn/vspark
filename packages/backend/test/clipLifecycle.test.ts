import { describe, it, expect } from 'vitest';
import { finishedClips } from '../src/track_clips/lifecycle.js';
import type { ClipPlaybackDoc } from '@vspark/shared/clipPlayback';

/**
 * Finishing a clip is DERIVED, not scheduled.
 *
 * The old playhead armed a `setTimeout` per clip and treated its firing as the
 * end. That is a second source of truth for something the document already
 * says: a clip is over when its derived playhead passes its duration, and every
 * peer can work that out from the same inputs. These pin the rule itself, which
 * is why the function is pure over its inputs — no clock, no database, no peer.
 */
const NOW = 1_700_000_000_000;

const doc = (over: Partial<ClipPlaybackDoc>): ClipPlaybackDoc => ({
  id: 'pb:c1',
  clipId: 'c1',
  state: 'stopped',
  startEpoch: null,
  pausedAtT: null,
  speed: 1,
  loop: false,
  ...over,
});

const tenSeconds = () => 10;

describe('finishedClips', () => {
  it('reports a clip whose playhead has passed its duration', () => {
    const d = doc({ state: 'playing', startEpoch: NOW - 11_000 });
    expect(finishedClips([d], tenSeconds, NOW)).toEqual(['c1']);
  });

  it('leaves a clip that is still running', () => {
    const d = doc({ state: 'playing', startEpoch: NOW - 4_000 });
    expect(finishedClips([d], tenSeconds, NOW)).toEqual([]);
  });

  it('NEVER finishes a looping clip, however long it has run', () => {
    // The reason the old manager only ever armed a timer for non-looping clips:
    // a loop's playhead wraps forever.
    const d = doc({
      state: 'playing',
      startEpoch: NOW - 10_000_000,
      loop: true,
    });
    expect(finishedClips([d], tenSeconds, NOW)).toEqual([]);
  });

  it('ignores paused and stopped clips', () => {
    expect(
      finishedClips(
        [
          doc({ state: 'paused', pausedAtT: 99 }),
          doc({ state: 'stopped', clipId: 'c2' }),
        ],
        tenSeconds,
        NOW
      )
    ).toEqual([]);
  });

  it('accounts for speed — a clip at 2x finishes in half the wall time', () => {
    const fast = doc({ state: 'playing', startEpoch: NOW - 6_000, speed: 2 });
    expect(finishedClips([fast], tenSeconds, NOW)).toEqual(['c1']);
    const slow = doc({ state: 'playing', startEpoch: NOW - 6_000, speed: 0.5 });
    expect(finishedClips([slow], tenSeconds, NOW)).toEqual([]);
  });

  it('skips a clip whose duration this server cannot resolve', () => {
    // A spawned clone that never registered its duration would otherwise be
    // stopped instantly (or never), depending on how the unknown was treated.
    const d = doc({ state: 'playing', startEpoch: NOW - 11_000 });
    expect(finishedClips([d], () => undefined, NOW)).toEqual([]);
    expect(finishedClips([d], () => 0, NOW)).toEqual([]);
  });

  it('finishes exactly at the duration boundary, not a frame later', () => {
    const d = doc({ state: 'playing', startEpoch: NOW - 10_000 });
    expect(finishedClips([d], tenSeconds, NOW)).toEqual(['c1']);
  });

  it('reports several at once', () => {
    const a = doc({ clipId: 'a', state: 'playing', startEpoch: NOW - 11_000 });
    const b = doc({ clipId: 'b', state: 'playing', startEpoch: NOW - 1_000 });
    const c = doc({ clipId: 'c', state: 'playing', startEpoch: NOW - 20_000 });
    expect(finishedClips([a, b, c], tenSeconds, NOW)).toEqual(['a', 'c']);
  });
});
