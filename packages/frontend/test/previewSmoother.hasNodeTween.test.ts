/**
 * previewSmoother.hasNodeTween.test.ts
 *
 * hasNodeTween decides how a COMMITTED value lands: mid-gesture it retargets the
 * running tween so the node glides to its final pose; outside a gesture the
 * value applies immediately.
 *
 * The trap this pins: node position and scale are scalar tweens, but rotation is
 * ONLY ever a quaternion tween (retargetQuat). The compose-layer equivalent,
 * hasLayerTween, scans `scalarTweens` alone — copying it verbatim would report
 * "no tween" for a rotate-only drag, and the committed value would snap.
 *
 * Note the module-level tween maps: `requestAnimationFrame` is stubbed out so
 * tweens stay live for the assertions, which means they never complete either.
 * Each test therefore takes a FRESH module registry — otherwise a scalar tween
 * from an earlier test leaks in and makes the rotate-only case pass for the
 * wrong reason (it did, before this was fixed).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const NODE = 'n1';

const nodeWith = (t: Record<string, number>) =>
  ({
    id: NODE,
    projectId: 'p1',
    name: 'N',
    kind: 'group',
    rootSceneNodeId: 's1',
    components: { transform: { type: 'transform', ...t } },
  }) as never;

type Smoother = typeof import('../src/previewSmoother');
let ps: Smoother;

async function fresh(): Promise<Smoother> {
  vi.resetModules();
  const { useEditorStore } = await import('../src/store/editorStore');
  useEditorStore.setState({
    nodes: [nodeWith({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 })],
  });
  return import('../src/previewSmoother');
}

describe('hasNodeTween', () => {
  beforeEach(async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    ps = await fresh();
  });

  it('is false with no gesture in flight', () => {
    expect(ps.hasNodeTween(NODE)).toBe(false);
  });

  it('is true during a position drag', () => {
    ps.smoothNodeTransform(NODE, { x: 5 });
    expect(ps.hasNodeTween(NODE)).toBe(true);
  });

  it('is true during a ROTATE-ONLY drag', () => {
    // The regression: rotation produces NO scalar tween, only a quaternion one,
    // so a scalarTweens-only scan misses it entirely.
    ps.smoothNodeTransform(NODE, { ry: 1.2 });
    expect(ps.hasNodeTween(NODE)).toBe(true);
  });

  it('does not confuse a node with a layer of the same id', () => {
    ps.smoothNodeTransform(NODE, { x: 5 });
    expect(ps.hasLayerTween(NODE)).toBe(false);
  });

  it('is false for a different node', () => {
    ps.smoothNodeTransform(NODE, { x: 5, ry: 1.2 });
    expect(ps.hasNodeTween('other')).toBe(false);
  });
});
