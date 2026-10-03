/**
 * clipPlayhead.test.ts — the derivation that replaces the streamed playhead.
 *
 * Nothing ships evaluated frames any more: every peer holds the clip and its
 * clip_playback document and computes the same number. These pin that the
 * forward derivation and its inverse agree, because a drift between them shows
 * up as a clip that jumps whenever it is resumed or scrubbed.
 */
import { describe, it, expect } from 'vitest';
import {
  anchorFor,
  playbackDocId,
  playheadAt,
} from '@vspark/shared/clipPlayback';
import type { ClipPlayback } from '../src/store/editorStore';

const NOW = 1_700_000_000_000;

const pb = (over: Partial<ClipPlayback>): ClipPlayback => ({
  id: 'pb:c1',
  clipId: 'c1',
  state: 'stopped',
  startEpoch: null,
  pausedAtT: null,
  speed: 1,
  loop: false,
  ...over,
});

describe('playbackDocId', () => {
  it('is derived from the clip, so concurrent creates race on ONE doc', () => {
    // Two tabs pressing Play on a never-played clip must not mint two documents
    // — the second would trip UNIQUE(clip_id) on persist.
    expect(playbackDocId('c1')).toBe(playbackDocId('c1'));
  });

  it('never equals the clip id, which would collide in the containment index', () => {
    expect(playbackDocId('c1')).not.toBe('c1');
  });
});

describe('playheadAt', () => {
  it('is null when there is no playback state at all', () => {
    expect(playheadAt(undefined, NOW)).toBeNull();
  });

  it('is null when stopped — the caller drives nothing, not zero', () => {
    expect(playheadAt(pb({ state: 'stopped' }), NOW)).toBeNull();
  });

  it('advances with the wall clock while playing', () => {
    const p = pb({ state: 'playing', startEpoch: NOW - 2000 });
    expect(playheadAt(p, NOW)).toBeCloseTo(2, 6);
    expect(playheadAt(p, NOW + 1000)).toBeCloseTo(3, 6);
  });

  it('scales by speed', () => {
    const p = pb({ state: 'playing', startEpoch: NOW - 2000, speed: 2 });
    expect(playheadAt(p, NOW)).toBeCloseTo(4, 6);
  });

  it('is frozen while paused, regardless of the clock', () => {
    const p = pb({ state: 'paused', pausedAtT: 1.25 });
    expect(playheadAt(p, NOW)).toBe(1.25);
    expect(playheadAt(p, NOW + 60_000)).toBe(1.25);
  });

  it('is null when playing with no anchor (a malformed doc drives nothing)', () => {
    expect(
      playheadAt(pb({ state: 'playing', startEpoch: null }), NOW)
    ).toBeNull();
  });
});

describe('anchorFor is the inverse of playheadAt', () => {
  it('round-trips at speed 1', () => {
    const t = 3.5;
    const p = pb({ state: 'playing', startEpoch: anchorFor(t, 1, NOW) });
    expect(playheadAt(p, NOW)).toBeCloseTo(t, 3);
  });

  it('round-trips at other speeds', () => {
    for (const speed of [0.5, 2, 3]) {
      const t = 4.2;
      const p = pb({
        state: 'playing',
        speed,
        startEpoch: anchorFor(t, speed, NOW),
      });
      expect(playheadAt(p, NOW)).toBeCloseTo(t, 2);
    }
  });

  it('resuming a pause continues from exactly where it froze', () => {
    // The concrete reason the two must agree: pause reads the playhead, resume
    // writes the anchor back, and a mismatch is a visible jump.
    const paused = pb({ state: 'paused', pausedAtT: 7.75 });
    const frozen = playheadAt(paused, NOW)!;
    const resumed = pb({
      state: 'playing',
      startEpoch: anchorFor(frozen, 1, NOW),
    });
    expect(playheadAt(resumed, NOW)).toBeCloseTo(7.75, 3);
  });
});
