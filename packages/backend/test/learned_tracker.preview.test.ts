/** PreviewHub (behaviors/learned_tracker/preview.ts): subscriptions, union, per-socket frames. */
import { describe, expect, it } from 'vitest';
import { PreviewHub } from '../src/behaviors/learned_tracker/preview.js';

const EV = {
  t: 1,
  width: 320,
  height: 240,
  mirrored: true,
  image: 'JPEG',
  landmarks: { pose: [] },
};

describe('PreviewHub', () => {
  it('asks the runtime for the union of what its subscribers want', () => {
    const hub = new PreviewHub<string>();
    expect(hub.set('b1', 'a', { image: true, landmarks: false })).toEqual({
      image: true,
      landmarks: false,
    });
    expect(hub.set('b1', 'b', { image: false, landmarks: true })).toEqual({
      image: true,
      landmarks: true,
    });
    expect(hub.set('b1', 'a', { image: false, landmarks: false })).toEqual({
      image: false,
      landmarks: true,
    });
    expect(hub.wanted('b2')).toEqual({ image: false, landmarks: false });
  });

  it('sends each socket only what it asked for', () => {
    const hub = new PreviewHub<string>();
    hub.set('b1', 'a', { image: true, landmarks: false });
    hub.set('b1', 'b', { image: false, landmarks: true });
    hub.set('b2', 'c', { image: true, landmarks: true });
    const d = Object.fromEntries(hub.deliveries('b1', EV));
    expect(Object.keys(d)).toEqual(['a', 'b']);
    expect(d.a).toMatchObject({ behaviorId: 'b1', image: 'JPEG', width: 320 });
    expect(d.a.landmarks).toBeUndefined();
    expect(d.b.image).toBeUndefined();
    expect(d.b.landmarks).toEqual({ pose: [] });
  });

  it('forgets a closed socket', () => {
    const hub = new PreviewHub<string>();
    hub.set('b1', 'a', { image: true, landmarks: true });
    hub.set('b2', 'a', { image: true, landmarks: false });
    hub.set('b2', 'b', { image: false, landmarks: true });
    expect(hub.drop('a').sort()).toEqual(['b1', 'b2']);
    expect(hub.wanted('b1')).toEqual({ image: false, landmarks: false });
    expect(hub.wanted('b2')).toEqual({ image: false, landmarks: true });
    expect(hub.drop('a')).toEqual([]);
  });
});
