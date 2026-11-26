/**
 * The page side of Live2D rendering (lib/puppet2d/live2d/Live2DRuntime.ts):
 * the model draws in a worker; this proxy forwards parameters and shows the
 * pictures that come back. A fake Worker stands in for the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Msg = { t: string; id: number; [k: string]: unknown };
let posted: Msg[] = [];
let deliver: (msg: unknown) => void = () => {};

class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor() {
    deliver = (data) => this.onmessage?.({ data });
  }
  postMessage(m: Msg) {
    posted.push(m);
  }
}
const bitmap = () =>
  ({ close: vi.fn() }) as unknown as ImageBitmap & {
    close: ReturnType<typeof vi.fn>;
  };

async function fresh() {
  vi.resetModules();
  return (await import('../src/lib/puppet2d/live2d/Live2DRuntime'))
    .Live2DRuntime;
}

describe('Live2DRuntime (worker proxy)', () => {
  beforeEach(() => {
    posted = [];
    vi.stubGlobal('Worker', FakeWorker);
    localStorage.setItem('vspark.live2d.accepted', '1');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('does not load without license consent', async () => {
    localStorage.clear();
    const rt = new (await fresh())();
    await expect(rt.load('/m.model3.json')).rejects.toThrow(/license/);
    expect(posted).toEqual([]);
  });

  it('loads in the worker and resolves once the first picture arrives', async () => {
    const rt = new (await fresh())();
    let done = false;
    const p = rt.load('/m.model3.json').then(() => (done = true));
    const load = posted[0];
    expect(load).toMatchObject({ t: 'load', url: '/m.model3.json' });
    expect(load.coreUrl).toMatch(/live2dcubismcore/);
    deliver({ t: 'loaded', id: load.id, params: ['ParamAngleX'] });
    await Promise.resolve();
    expect(done).toBe(false);
    const b = bitmap();
    deliver({ t: 'bitmap', id: load.id, bitmap: b });
    await p;
    expect(rt.listParams()).toEqual(['ParamAngleX']);
    expect(rt.renderToTexture().image).toBe(b);
  });

  it('sends one frame at a time, carrying the latest parameters', async () => {
    const rt = new (await fresh())();
    const p = rt.load('/m.model3.json');
    const id = posted[0].id;
    deliver({ t: 'loaded', id, params: [] });
    const first = bitmap();
    deliver({ t: 'bitmap', id, bitmap: first });
    await p;
    posted = [];

    rt.setParam('A', 1);
    rt.update(0.016);
    rt.setParam('A', 2);
    rt.setParam('B', 3);
    rt.update(0.016); // previous frame still drawing: nothing queued
    expect(posted).toEqual([{ t: 'frame', id, params: [['A', 1]] }]);

    const second = bitmap();
    deliver({ t: 'bitmap', id, bitmap: second });
    expect(first.close).toHaveBeenCalled(); // replaced pictures are released
    rt.update(0.016);
    expect(posted[1]).toEqual({
      t: 'frame',
      id,
      params: [
        ['A', 2],
        ['B', 3],
      ],
    });
  });

  it('dispose tells the worker and releases the picture', async () => {
    const rt = new (await fresh())();
    const p = rt.load('/m.model3.json');
    const id = posted[0].id;
    deliver({ t: 'loaded', id, params: [] });
    const b = bitmap();
    deliver({ t: 'bitmap', id, bitmap: b });
    await p;
    rt.dispose();
    expect(posted.at(-1)).toEqual({ t: 'dispose', id });
    expect(b.close).toHaveBeenCalled();
    // A picture still on its way is dropped and released.
    const late = bitmap();
    deliver({ t: 'bitmap', id, bitmap: late });
    expect(late.close).toHaveBeenCalled();
  });
});
