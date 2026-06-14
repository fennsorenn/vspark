import { describe, expect, it } from 'vitest';
import { Replica } from '../src/replica.js';
import {
  deepEqual,
  flattenToLeaves,
  getPath,
  setPath,
} from '../src/paths.js';
import type { HLC } from '@vspark/shared/sync';

const v = (t: number): HLC => ({ t, c: 0, n: 'X' });
const meta = { origin: 'X', channel: 'committed' };

interface Doc {
  id: string;
  name?: string;
  pos?: { x: number; y: number };
  [k: string]: unknown;
}

describe('paths', () => {
  it('gets and sets dotted paths immutably', () => {
    const doc = { id: 'a', pos: { x: 1, y: 2 } };
    const next = setPath(doc, 'pos.x', 9);
    expect(getPath(next, 'pos.x')).toBe(9);
    expect(getPath(next, 'pos.y')).toBe(2);
    expect(doc.pos.x).toBe(1); // original untouched
  });

  it('treats arrays and scalars as leaves when flattening', () => {
    const leaves = flattenToLeaves({ a: { b: 1 }, c: [1, 2], d: 'x' });
    expect(leaves).toEqual([
      ['a.b', 1],
      ['c', [1, 2]],
      ['d', 'x'],
    ]);
  });

  it('deepEqual handles nesting and arrays', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe('Replica LWW', () => {
  it('rejects upserts older than the current root', () => {
    const r = new Replica<Doc>();
    expect(r.upsert('a', { id: 'a', name: 'new' }, v(5), meta)).toBeTruthy();
    expect(r.upsert('a', { id: 'a', name: 'old' }, v(3), meta)).toBeNull();
    expect(r.get('a')?.name).toBe('new');
  });

  it('preserves path values newer than a doc replace', () => {
    const r = new Replica<Doc>();
    r.upsert('a', { id: 'a', name: 'v1', pos: { x: 0, y: 0 } }, v(1), meta);
    r.patch('a', 'name', 'edited', v(5), meta);
    // A whole-doc replace stamped BETWEEN the create and the field edit.
    r.upsert('a', { id: 'a', name: 'replaced', pos: { x: 9, y: 9 } }, v(3), meta);
    expect(r.get('a')?.name).toBe('edited'); // newer field edit survives
    expect(r.get('a')?.pos).toEqual({ x: 9, y: 9 });
  });

  it('rejects a patch older than an ancestor write', () => {
    const r = new Replica<Doc>();
    r.upsert('a', { id: 'a', pos: { x: 0, y: 0 } }, v(1), meta);
    r.patch('a', 'pos', { x: 5, y: 5 }, v(10), meta);
    expect(r.patch('a', 'pos.x', 99, v(7), meta)).toBeNull();
    expect(r.get('a')?.pos).toEqual({ x: 5, y: 5 });
  });

  it('tombstones block stale upserts; newer upserts resurrect', () => {
    const r = new Replica<Doc>();
    r.upsert('a', { id: 'a' }, v(1), meta);
    r.remove('a', v(10), meta);
    expect(r.upsert('a', { id: 'a', name: 'stale' }, v(8), meta)).toBeNull();
    expect(r.get('a')).toBeUndefined();
    expect(r.upsert('a', { id: 'a', name: 'fresh' }, v(12), meta)).toBeTruthy();
    expect(r.get('a')?.name).toBe('fresh');
  });

  it('parks orphan patches and replays them on upsert (LWW respected)', () => {
    const r = new Replica<Doc>();
    expect(r.patch('a', 'name', 'early', v(5), meta)).toBeNull(); // parked
    expect(r.patch('a', 'pos.x', 1, v(2), meta)).toBeNull(); // parked, stale
    r.upsert('a', { id: 'a', name: 'base', pos: { x: 0, y: 0 } }, v(3), meta);
    expect(r.get('a')?.name).toBe('early'); // 5 > 3 → replayed
    expect(r.get('a')?.pos?.x).toBe(0); // 2 < 3 → dropped
  });

  it('merge-patch applies leaves under one stamp', () => {
    const r = new Replica<Doc>();
    r.upsert('a', { id: 'a', name: 'n', pos: { x: 0, y: 0 } }, v(1), meta);
    r.patch('a', 'pos.x', 42, v(9), meta); // newer field edit
    const c = r.mergePatch('a', { name: 'm', pos: { x: 1, y: 1 } }, v(5), meta);
    expect(c).toBeTruthy();
    expect(r.get('a')?.name).toBe('m');
    expect(r.get('a')?.pos).toEqual({ x: 42, y: 1 }); // x kept (9 > 5)
  });

  it('overlays compose on read and are cleared by a covering retained write', () => {
    const r = new Replica<Doc>();
    r.upsert('a', { id: 'a', pos: { x: 0, y: 0 } }, v(1), meta);
    r.ephemeral('a', 'pos.x', 7, { origin: 'X', channel: 'preview' });
    expect(r.get('a')?.pos?.x).toBe(7); // overlay wins on read
    expect(r.raw('a')?.pos?.x).toBe(0); // retained untouched
    r.patch('a', 'pos', { x: 3, y: 3 }, v(2), meta); // covers pos.x
    expect(r.get('a')?.pos?.x).toBe(3); // overlay cleared by the landing write
  });

  it('captureState/restoreState rolls back wholesale; newestStamp gates', () => {
    const r = new Replica<Doc>();
    r.upsert('a', { id: 'a', name: 'before' }, v(1), meta);
    const pre = r.captureState('a');
    r.patch('a', 'name', 'optimistic', v(5), meta);
    expect(r.newestStamp('a')).toEqual(v(5));
    r.restoreState('a', pre, meta);
    expect(r.get('a')?.name).toBe('before');
    expect(r.newestStamp('a')).toEqual(v(1));
  });
});
