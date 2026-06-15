import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Blendshapes,
  NormalizedPose,
  Quaternion,
} from '@vspark/shared/signal';
import { pullValue, buildGraph } from './helpers/nodeHarness.js';
import { mkEvent } from '@vspark/shared/signal';

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

describe('arkit_vrm_mapper', () => {
  it('maps ARKit shapes onto VRM expressions (expressions mode)', () => {
    const out = pullValue('arkit_vrm_mapper', 'blendshapes', {
      arkit: Blendshapes.fromRecord({ mouthSmileLeft: 1 }),
      mode: 'expressions',
    }) as Blendshapes;
    expect(out.get('happy')).toBeCloseTo(0.3, 6); // mouthSmileLeft → happy×0.3
  });

  it('passthrough mode returns the input unchanged', () => {
    const arkit = Blendshapes.fromRecord({ jawOpen: 0.8 });
    const out = pullValue('arkit_vrm_mapper', 'blendshapes', {
      arkit,
      mode: 'passthrough',
    }) as Blendshapes;
    expect(out.get('jawOpen')).toBe(0.8);
  });

  it('clamps summed contributions to 1', () => {
    // browDownLeft + browDownRight both map to angry×0.5 → 1.0 total.
    const out = pullValue('arkit_vrm_mapper', 'blendshapes', {
      arkit: Blendshapes.fromRecord({ browDownLeft: 1, browDownRight: 1 }),
      mode: 'expressions',
    }) as Blendshapes;
    expect(out.get('angry')).toBe(1);
  });

  it('outputs nothing when disabled or unconnected', () => {
    expect(
      (
        pullValue('arkit_vrm_mapper', 'blendshapes', {
          arkit: Blendshapes.fromRecord({ jawOpen: 1 }),
          enabled: false,
        }) as Blendshapes
      ).size
    ).toBe(0);
    expect((pullValue('arkit_vrm_mapper', 'blendshapes', {}) as Blendshapes).size).toBe(0);
  });
});

describe('pose_apply_bone', () => {
  const q = new Quaternion(0, 0, Math.SQRT1_2, Math.SQRT1_2);

  it('set mode places the quaternion on the bone (from an empty pose)', () => {
    const out = pullValue('pose_apply_bone', 'pose', {
      quaternion: q,
      bone: 'head',
      mode: 'set',
    }) as NormalizedPose;
    expect(out.get('head')!.toArray()).toEqual(q.toArray());
  });

  it('multiply onto an absent bone equals the delta (identity × q = q)', () => {
    const out = pullValue('pose_apply_bone', 'pose', {
      quaternion: q,
      bone: 'head',
      mode: 'multiply',
    }) as NormalizedPose;
    const r = out.get('head')!;
    expect(r.x).toBeCloseTo(q.x, 6);
    expect(r.w).toBeCloseTo(q.w, 6);
  });

  it('returns the pose unchanged when quaternion or bone is missing', () => {
    expect((pullValue('pose_apply_bone', 'pose', { bone: 'head' }) as NormalizedPose).size).toBe(0);
    expect((pullValue('pose_apply_bone', 'pose', { quaternion: q }) as NormalizedPose).size).toBe(0);
  });
});

// pose_merge + blendshapes_sum exercise LIST fan-in, so they need real upstream
// edges (config fallback can't supply a list port). Wire producers into them.
function mergeOf(
  producers: { id: string; config: Record<string, unknown> }[]
): NormalizedPose {
  const { graph } = buildGraph(
    [
      ...producers.map((p) => ({ id: p.id, kind: 'pose_apply_bone' })),
      { id: 'merge', kind: 'pose_merge' },
      { id: 'trg', kind: 'component_trigger' },
      { id: 'sink', kind: 'log' },
    ],
    [
      ...producers.map((p) => ({
        fromNodeId: p.id,
        fromPort: 'pose',
        toNodeId: 'merge',
        toPort: 'poses',
      })),
      { fromNodeId: 'merge', fromPort: 'pose', toNodeId: 'sink', toPort: 'inputs' },
      { fromNodeId: 'trg', fromPort: 'trigger', toNodeId: 'sink', toPort: 'trigger' },
    ],
    Object.fromEntries(producers.map((p) => [p.id, p.config]))
  );
  graph.fire('trg', 'trigger', mkEvent(undefined));
  return (graph.peekInput('sink', 'inputs') as unknown[])[0] as NormalizedPose;
}

describe('pose_merge (list fan-in)', () => {
  const qHips = new Quaternion(0, 0, Math.SQRT1_2, Math.SQRT1_2);
  const qSpine = new Quaternion(Math.SQRT1_2, 0, 0, Math.SQRT1_2);

  it('combines bones from multiple partial poses', () => {
    const merged = mergeOf([
      { id: 'a', config: { quaternion: qHips, bone: 'hips', mode: 'set' } },
      { id: 'b', config: { quaternion: qSpine, bone: 'spine', mode: 'set' } },
    ]);
    expect(merged.get('hips')!.toArray()).toEqual(qHips.toArray());
    expect(merged.get('spine')!.toArray()).toEqual(qSpine.toArray());
  });

  it('skips identity quaternions from later poses (no-data marker)', () => {
    const merged = mergeOf([
      { id: 'a', config: { quaternion: qHips, bone: 'hips', mode: 'set' } },
      {
        id: 'b',
        config: { quaternion: Quaternion.IDENTITY, bone: 'hips', mode: 'set' },
      },
    ]);
    // The identity from b must NOT overwrite a's real rotation.
    expect(merged.get('hips')!.toArray()).toEqual(qHips.toArray());
  });
});

describe('blendshapes_sum (list fan-in)', () => {
  it('additively merges sources, clamping to 1', () => {
    const { graph } = buildGraph(
      [
        { id: 'm1', kind: 'arkit_vrm_mapper' },
        { id: 'm2', kind: 'arkit_vrm_mapper' },
        { id: 'sum', kind: 'blendshapes_sum' },
        { id: 'trg', kind: 'component_trigger' },
        { id: 'sink', kind: 'log' },
      ],
      [
        { fromNodeId: 'm1', fromPort: 'blendshapes', toNodeId: 'sum', toPort: 'sources' },
        { fromNodeId: 'm2', fromPort: 'blendshapes', toNodeId: 'sum', toPort: 'sources' },
        { fromNodeId: 'sum', fromPort: 'blendshapes', toNodeId: 'sink', toPort: 'inputs' },
        { fromNodeId: 'trg', fromPort: 'trigger', toNodeId: 'sink', toPort: 'trigger' },
      ],
      {
        // both produce `happy` (0.3 each) → summed 0.6; m2 also adds surprised.
        m1: { arkit: Blendshapes.fromRecord({ mouthSmileLeft: 1 }), mode: 'expressions' },
        m2: {
          arkit: Blendshapes.fromRecord({ mouthSmileRight: 1, browInnerUp: 1 }),
          mode: 'expressions',
        },
      }
    );
    graph.fire('trg', 'trigger', mkEvent(undefined));
    const out = (graph.peekInput('sink', 'inputs') as unknown[])[0] as Blendshapes;
    expect(out.get('happy')).toBeCloseTo(0.6, 6);
    expect(out.get('surprised')).toBeCloseTo(0.6, 6);
  });
});
