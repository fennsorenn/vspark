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

  async function withLayer(doc: Record<string, unknown>) {
    const t = await fresh();
    const { getMeshHandles } = await import('../src/mesh/peer');
    getMeshHandles()!
      .peer.collection<{ id: string }>('compose_layer')
      .put(
        {
          id: 'L1',
          projectId: 'p1',
          kind: 'image',
          name: 'L',
          rootComposeSceneId: 'cs',
          parentId: null,
          orderKey: 'a0',
          ...doc,
        } as never,
        { v: { t: 1, c: 0, n: 'seed' } }
      );
    return t;
  }

  it('a compose layer moves evenly through bunched and late samples', async () => {
    const { ps, store } = await withLayer({ x: 0, y: 0 });
    const arrivals = [0, 33, 66, 140, 145, 165, 198, 231];
    const shown: number[] = [];
    let next = 0;
    for (clock = 0; clock <= 600; clock += 16) {
      while (next < arrivals.length && arrivals[next] <= clock) {
        ps.smoothComposeLayer('L1', { x: (next + 1) * 10 });
        next++;
      }
      const f = frame;
      frame = null;
      f?.();
      shown.push((store.getState().liveLayers.L1 as { x?: number })?.x ?? -1);
    }
    const moving = shown.filter((v) => v > 0 && v < 80);
    for (let i = 1; i < moving.length; i++)
      expect(moving[i]).toBeGreaterThan(moving[i - 1]);
    // Played out: the live value goes, the document (holding the last
    // preview) shows on its own.
    expect(store.getState().liveLayers.L1).toBeUndefined();
    expect(ps.hasLayerTween('L1')).toBe(false);
  });

  it('layer rotation takes the short way round', async () => {
    const { ps, store } = await withLayer({ rotation: 350 });
    ps.smoothComposeLayer('L1', { rotation: 10 });
    const seen: number[] = [];
    for (clock = 0; clock <= 400; clock += 16) {
      const f = frame;
      frame = null;
      f?.();
      const r = (store.getState().liveLayers.L1 as { rotation?: number })
        ?.rotation;
      if (typeof r === 'number') seen.push(r);
    }
    // Through 360, never back down through 180.
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(350);
    expect(Math.max(...seen)).toBeLessThanOrEqual(370);
  });
});
