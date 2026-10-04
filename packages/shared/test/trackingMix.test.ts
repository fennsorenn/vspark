import { describe, it, expect } from 'vitest';
import { Quaternion, VRM_BONE_NAMES } from '../src/signal.js';
import {
  ANIMATION_SOURCE,
  MIX_REGIONS,
  MIX_REGION_BONES,
  blendshapeWeight,
  boneRegion,
  boneWeight,
  clampMixWeight,
  faceGroupOf,
  orderSources,
  pruneMix,
  pruneStaleSources,
  resetValueFor,
  scaleRotation,
  setBlendshapeWeights,
  setBoneWeights,
  uniformValue,
} from '../src/trackingMix.js';

const axisAngle = (ax: [number, number, number], rad: number) =>
  new Quaternion(
    ax[0] * Math.sin(rad / 2),
    ax[1] * Math.sin(rad / 2),
    ax[2] * Math.sin(rad / 2),
    Math.cos(rad / 2)
  );

describe('regions', () => {
  it('assign every VRM bone to exactly one region', () => {
    const all = MIX_REGIONS.flatMap((r) => MIX_REGION_BONES[r]);
    expect(all).toHaveLength(VRM_BONE_NAMES.length);
    expect(new Set(all).size).toBe(VRM_BONE_NAMES.length);
  });

  it('puts fingers under hands and hips under legs', () => {
    expect(boneRegion('leftIndexProximal')).toBe('hands');
    expect(boneRegion('hips')).toBe('legs');
    expect(boneRegion('jaw')).toBe('head');
    expect(boneRegion('notABone')).toBe('hands');
  });
});

describe('faceGroupOf', () => {
  it.each([
    ['Fcl_MTH_A', 'mouth'],
    ['Fcl_HA_Fung1', 'mouth'],
    ['Fcl_EYE_Close', 'eyes'],
    ['Fcl_BRW_Angry', 'brows'],
    ['Fcl_ALL_Joy', 'emotions'],
    ['aa', 'mouth'],
    ['A', 'mouth'],
    ['blinkLeft', 'eyes'],
    ['lookUp', 'eyes'],
    ['happy', 'emotions'],
    ['Joy', 'emotions'],
    ['jawOpen', 'mouth'],
    ['eyeBlinkLeft', 'eyes'],
    ['browInnerUp', 'brows'],
    ['cheekPuff', 'other'],
  ])('%s → %s', (name, group) => {
    expect(faceGroupOf(name)).toBe(group);
  });
});

describe('weights', () => {
  const mix = {
    sources: {
      a: { bones: { head: 0.5 }, blendshapes: { aa: 0 } },
      b: { bones: { head: 5 } },
    },
  };
  it('default to 1 and clamp into 0..2', () => {
    expect(boneWeight(undefined, 'a', 'head')).toBe(1);
    expect(boneWeight(mix, 'a', 'neck')).toBe(1);
    expect(boneWeight(mix, 'a', 'head')).toBe(0.5);
    expect(boneWeight(mix, 'b', 'head')).toBe(2);
    expect(blendshapeWeight(mix, 'a', 'aa')).toBe(0);
    expect(blendshapeWeight(mix, 'b', 'aa')).toBe(1);
    expect(clampMixWeight(NaN)).toBe(1);
    expect(clampMixWeight(-1)).toBe(0);
  });
});

describe('orderSources', () => {
  const s = [
    { id: 'breath', priority: 10 },
    { id: 'vmc', priority: 0 },
    { id: 'mp', priority: 0 },
  ];
  it('falls back to ascending priority, stable on ties', () => {
    expect(orderSources(undefined, s).map((x) => x.id)).toEqual([
      'vmc',
      'mp',
      'breath',
    ]);
  });
  it('puts listed sources first in mix order, ignoring unknown ids', () => {
    expect(
      orderSources({ order: ['ghost', 'breath', 'mp'] }, s).map((x) => x.id)
    ).toEqual(['breath', 'mp', 'vmc']);
  });
});

describe('scaleRotation', () => {
  const q = axisAngle([0, 0, 1], 0.6);
  const angle = (r: Quaternion) => 2 * Math.acos(Math.min(1, Math.abs(r.w)));
  it('is identity at 0 and q at 1', () => {
    expect(scaleRotation(q, 0)).toBe(Quaternion.IDENTITY);
    expect(scaleRotation(q, 1)).toBe(q);
  });
  it('scales the angle linearly, including above 1', () => {
    expect(angle(scaleRotation(q, 0.5))).toBeCloseTo(0.3, 6);
    expect(angle(scaleRotation(q, 2))).toBeCloseTo(1.2, 6);
    expect(scaleRotation(q, 2).z).toBeGreaterThan(0);
  });
  it('takes the shortest arc for a negated quaternion', () => {
    const neg = new Quaternion(-q.x, -q.y, -q.z, -q.w);
    const r = scaleRotation(neg, 0.5);
    expect(angle(r)).toBeCloseTo(0.3, 6);
    expect(r.w).toBeGreaterThan(0);
  });
  it('returns identity for an identity input', () => {
    expect(scaleRotation(Quaternion.IDENTITY, 0.3)).toBe(Quaternion.IDENTITY);
  });
});

describe('uniformValue / resetValueFor', () => {
  it('reports a uniform value or null for mixed', () => {
    expect(uniformValue([])).toBe(1);
    expect(uniformValue([0.5, 0.5])).toBe(0.5);
    expect(uniformValue([0.5, 0.6])).toBeNull();
  });
  it('resets to the most frequent value', () => {
    expect(resetValueFor([0.2, 0.5, 0.5, 0.9])).toBe(0.5);
  });
  it('breaks ties toward the higher value', () => {
    expect(resetValueFor([0.5, 0.5, 0.8, 0.8, 0.1])).toBe(0.8);
  });
  it('falls back to 1 when nothing repeats', () => {
    expect(resetValueFor([0.2, 0.3, 0.4])).toBe(1);
    expect(resetValueFor([])).toBe(1);
  });
});

describe('editing helpers', () => {
  it('setBoneWeights / setBlendshapeWeights write every member', () => {
    const m1 = setBoneWeights(undefined, 'a', ['head', 'neck'], 0.4);
    expect(m1.sources!.a.bones).toEqual({ head: 0.4, neck: 0.4 });
    const m2 = setBlendshapeWeights(m1, 'a', ['aa'], 3);
    expect(m2.sources!.a.blendshapes).toEqual({ aa: 2 });
    expect(m2.sources!.a.bones).toEqual({ head: 0.4, neck: 0.4 });
  });

  it('pruneMix keeps only deviations and drops animation from order', () => {
    expect(pruneMix(undefined)).toBeUndefined();
    expect(
      pruneMix({
        sources: { a: { bones: { head: 1 }, blendshapes: { aa: 1 } } },
      })
    ).toBeUndefined();
    expect(
      pruneMix({
        order: [ANIMATION_SOURCE, 'a'],
        sources: { a: { bones: { head: 0.5, neck: 1 } } },
      })
    ).toEqual({ order: ['a'], sources: { a: { bones: { head: 0.5 } } } });
  });

  it('pruneStaleSources removes deleted behaviors but keeps animation', () => {
    const out = pruneStaleSources(
      {
        order: ['a', 'gone'],
        sources: { a: {}, gone: {}, [ANIMATION_SOURCE]: {} },
      },
      new Set(['a'])
    );
    expect(out!.order).toEqual(['a']);
    expect(Object.keys(out!.sources!)).toEqual(['a', ANIMATION_SOURCE]);
    expect(pruneStaleSources(undefined, new Set())).toBeUndefined();
  });
});
