/**
 * Another tab's drag plays back at a steady speed even when its samples arrive
 * unevenly (previewSmoother node buffer). Restarting a tween per sample made
 * the speed jump with every arrival and stop in every long gap; here samples
 * bunch up and stall the way they did through the server, and what this tab
 * shows must still move forward evenly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NODE = 'n1';
let clock = 0;
let frame: (() => void) | null = null;

async function fresh() {
  vi.resetModules();
  const { getMeshHandles } = await import('../src/mesh/peer');
  getMeshHandles()!
    .peer.collection<{ id: string }>('scene_node')
    .put(
      {
        id: NODE,
        projectId: 'p1',
        name: 'N',
        kind: 'group',
        rootSceneNodeId: 's1',
        components: { transform: { type: 'transform', x: 0 } },
      } as never,
      { v: { t: 1, c: 0, n: 'seed' } }
    );
  const ps = await import('../src/previewSmoother');
  const { useEditorStore } = await import('../src/store/editorStore');
  return { ps, store: useEditorStore };
}

describe('node preview playback', () => {
  beforeEach(() => {
    clock = 0;
    frame = null;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      frame = cb;
      return 1;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('moves evenly through bunched and late samples', async () => {
    const { ps, store } = await fresh();
    // x = 1..8 sent every 33ms; arrivals: on time, two bunched, one 100ms late.
    const arrivals = [0, 33, 66, 140, 145, 165, 198, 231];
    const shown: number[] = [];
    let next = 0;
    for (clock = 0; clock <= 600; clock += 16) {
      while (next < arrivals.length && arrivals[next] <= clock) {
        ps.smoothNodeTransform(NODE, { x: next + 1 });
        next++;
      }
      const f = frame;
      frame = null;
      f?.();
      shown.push(store.getState().liveNodes[NODE]?.x ?? 0);
    }
    // Never backwards, and it gets there.
    for (let i = 1; i < shown.length; i++)
      expect(shown[i]).toBeGreaterThanOrEqual(shown[i - 1] - 1e-9);
    expect(shown[shown.length - 1]).toBeCloseTo(8, 5);
    // Once moving, no frame jumps far more than the average step, and it
    // does not stop until the end.
    const first = shown.findIndex((v) => v > 0);
    const last = shown.findIndex((v) => v >= 8 - 1e-9);
    const steps = shown
      .slice(first, last + 1)
      .map((v, i, a) => (i ? v - a[i - 1] : 0))
      .slice(1);
    const mean = steps.reduce((s, d) => s + d, 0) / steps.length;
    expect(Math.max(...steps)).toBeLessThan(mean * 3);
    expect(steps.filter((d) => d === 0).length).toBe(0);
  });

  it('rotation plays back as one quaternion, all three axes together', async () => {
    const { ps, store } = await fresh();
    ps.smoothNodeTransform(NODE, { rx: 0, ry: 1.2, rz: 0 });
    for (clock = 0; clock <= 400; clock += 16) {
      const f = frame;
      frame = null;
      f?.();
    }
    expect(store.getState().liveNodes[NODE]?.ry).toBeCloseTo(1.2, 5);
    expect(ps.hasNodeTween(NODE)).toBe(false);
  });
});
