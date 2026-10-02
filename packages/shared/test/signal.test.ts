import { describe, it, expect } from 'vitest';
import {
  VRM_BONE_NAMES,
  Quaternion,
  BoneRotations,
  NormalizedPose,
  Blendshapes,
  PoseFrame,
  mkEvent,
  SIGNAL_TYPE_COLORS,
  SignalNode,
  getNodeDisplay,
  type NodeDisplay,
} from '../src/signal.js';

describe('VRM_BONE_NAMES', () => {
  it('is the unique 55-bone humanoid registry', () => {
    expect(VRM_BONE_NAMES).toContain('hips');
    expect(VRM_BONE_NAMES).toContain('rightLittleDistal');
    expect(new Set(VRM_BONE_NAMES).size).toBe(VRM_BONE_NAMES.length);
  });
});

describe('Quaternion', () => {
  it('array round-trip + IDENTITY', () => {
    expect(Quaternion.IDENTITY.toArray()).toEqual([0, 0, 0, 1]);
    expect(Quaternion.fromArray([1, 2, 3, 4]).toArray()).toEqual([1, 2, 3, 4]);
  });

  it('magnitudeSquared / isValid', () => {
    expect(new Quaternion(0, 0, 0, 1).magnitudeSquared).toBe(1);
    expect(new Quaternion(0, 0, 0, 1).isValid).toBe(true);
    expect(new Quaternion(0, 0, 0, 0).isValid).toBe(false);
  });

  it('normalize yields a unit quaternion; degenerate → IDENTITY', () => {
    const n = new Quaternion(0, 0, 0, 2).normalize();
    expect(n.magnitudeSquared).toBeCloseTo(1, 12);
    expect(new Quaternion(0, 0, 0, 0).normalize()).toBe(Quaternion.IDENTITY);
  });

  it('invert of identity is identity; degenerate → IDENTITY', () => {
    const inv = Quaternion.IDENTITY.invert();
    expect(inv.toArray()).toEqual([-0, -0, -0, 1]);
    expect(new Quaternion(0, 0, 0, 0).invert()).toBe(Quaternion.IDENTITY);
  });

  it('multiply by identity is a no-op; premultiply mirrors multiply', () => {
    const q = new Quaternion(0.1, 0.2, 0.3, 0.9);
    expect(q.multiply(Quaternion.IDENTITY).toArray()).toEqual(q.toArray());
    expect(q.premultiply(Quaternion.IDENTITY).toArray()).toEqual(q.toArray());
    // q * q⁻¹ = identity for any non-zero quaternion
    const prod = q.multiply(q.invert());
    expect(prod.x).toBeCloseTo(0, 6);
    expect(prod.y).toBeCloseTo(0, 6);
    expect(prod.z).toBeCloseTo(0, 6);
    expect(prod.w).toBeCloseTo(1, 6);
  });

  it('slerp clamps t and returns the endpoints exactly', () => {
    const a = Quaternion.fromEuler(0, 0, 0);
    const b = Quaternion.fromEuler(0, Math.PI / 2, 0);
    expect(a.slerp(b, 0)).toBe(a);
    expect(a.slerp(b, 1)).toBe(b);
    expect(a.slerp(b, -5)).toBe(a);
    expect(a.slerp(b, 12)).toBe(b);
  });

  it('slerp halfway lands halfway along the arc and stays unit-length', () => {
    const a = Quaternion.fromEuler(0, 0, 0);
    const b = Quaternion.fromEuler(0, Math.PI / 2, 0);
    const mid = a.slerp(b, 0.5);
    expect(mid.toEuler().yaw).toBeCloseTo(Math.PI / 4, 6);
    expect(mid.magnitudeSquared).toBeCloseTo(1, 12);
  });

  it('slerp takes the shortest arc even when the inputs point apart', () => {
    const a = Quaternion.fromEuler(0, 0.2, 0);
    // Same rotation, opposite sign — the long way round would swing ~360°.
    const negB = new Quaternion(-a.x, -a.y, -a.z, -a.w);
    const mid = Quaternion.IDENTITY.slerp(negB, 0.5);
    expect(mid.toEuler().yaw).toBeCloseTo(0.1, 6);
  });

  it('slerp stays stable for nearly-parallel rotations (lerp fallback)', () => {
    const a = Quaternion.fromEuler(0, 0, 0);
    const b = Quaternion.fromEuler(0, 1e-6, 0);
    const mid = a.slerp(b, 0.5);
    expect(Number.isNaN(mid.x)).toBe(false);
    expect(mid.magnitudeSquared).toBeCloseTo(1, 12);
    expect(mid.toEuler().yaw).toBeCloseTo(5e-7, 10);
  });
});

describe('BoneRotations', () => {
  it('builds from a record and round-trips', () => {
    const br = BoneRotations.fromRecord({ hips: [0, 0, 0, 1] });
    expect(br.size).toBe(1);
    expect(br.has('hips')).toBe(true);
    expect(br.get('hips')).toBeInstanceOf(Quaternion);
    expect(br.get('missing')).toBeUndefined();
    expect([...br.keys()]).toEqual(['hips']);
    expect([...br.entries()]).toHaveLength(1);
    expect(br.toRecord()).toEqual({ hips: [0, 0, 0, 1] });
  });

  it('default (empty) construction', () => {
    expect(new BoneRotations().size).toBe(0);
  });

  it('map and filter return new instances', () => {
    const br = BoneRotations.fromRecord({ a: [0, 0, 0, 1], b: [1, 0, 0, 0] });
    const mapped = br.map((q) => q.invert());
    expect(mapped.get('a')).not.toBe(br.get('a'));
    const filtered = br.filter((bone) => bone === 'a');
    expect([...filtered.keys()]).toEqual(['a']);
  });
});

describe('NormalizedPose', () => {
  it('immutable with(); get/has/size/entries/keys/map/toRecord', () => {
    const p = new NormalizedPose([['hips', Quaternion.IDENTITY]]);
    const p2 = p.with('head', new Quaternion(0, 0, 0, 1));
    expect(p.size).toBe(1); // original untouched
    expect(p2.size).toBe(2);
    expect(p2.has('head')).toBe(true);
    expect(p2.get('hips')).toBeInstanceOf(Quaternion);
    expect([...p2.keys()]).toContain('head');
    expect([...p2.entries()]).toHaveLength(2);
    expect(p2.map((q) => q).toRecord().hips).toEqual([0, 0, 0, 1]);
  });
});

describe('NormalizedPose / Blendshapes empty construction', () => {
  it('construct with no entries', () => {
    expect(new NormalizedPose().size).toBe(0);
    expect(new Blendshapes().size).toBe(0);
  });
});

describe('Blendshapes', () => {
  it('missing names read 0; with() clamps to [0,1]', () => {
    const b = Blendshapes.fromRecord({ happy: 0.5 });
    expect(b.get('happy')).toBe(0.5);
    expect(b.get('absent')).toBe(0);
    expect(b.has('happy')).toBe(true);
    expect(b.size).toBe(1);
    expect(b.with('over', 5).get('over')).toBe(1);
    expect(b.with('under', -3).get('under')).toBe(0);
    expect([...b.entries()]).toHaveLength(1);
    expect(b.map((v) => v * 2).get('happy')).toBe(1);
    expect(b.toRecord()).toEqual({ happy: 0.5 });
  });
});

describe('PoseFrame + mkEvent', () => {
  it('toWire serialises pose + blendshapes', () => {
    const frame = new PoseFrame(
      'bhv1',
      new NormalizedPose([['hips', Quaternion.IDENTITY]]),
      Blendshapes.fromRecord({ happy: 0.5 }),
      123
    );
    expect(frame.toWire()).toEqual({
      bones: { hips: [0, 0, 0, 1] },
      blendshapes: { happy: 0.5 },
    });
    expect(frame.timestamp).toBe(123);
  });

  it('mkEvent carries payload + a timestamp', () => {
    expect(mkEvent('hi', 7)).toEqual({ payload: 'hi', timestamp: 7 });
    expect(typeof mkEvent('hi').timestamp).toBe('number');
  });
});

describe('SIGNAL_TYPE_COLORS + @SignalNode', () => {
  it('has a colour for every type name', () => {
    expect(SIGNAL_TYPE_COLORS.Float).toMatch(/^#/);
    expect(SIGNAL_TYPE_COLORS.SceneEntity).toMatch(/^#/);
  });

  it('SignalNode attaches retrievable display metadata', () => {
    const display: NodeDisplay = { label: 'Demo', tags: ['x'], color: '#fff' };
    class Demo {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SignalNode(display)(Demo, { metadata: {} } as any);
    expect(getNodeDisplay(Demo)).toBe(display);
    expect(getNodeDisplay(class Undecorated {})).toBeUndefined();
  });
});
