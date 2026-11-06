/// <reference lib="webworker" />
// ---------------------------------------------------------------------------
// Live2D rendering off the main thread.
//
// Hosts every Live2D model of the page (one OffscreenCanvas + WebGL2 context
// each) and runs the Cubism model update, physics and draw here. Each frame
// the page sends the parameters it derived from tracking; the worker draws and
// sends the result back as an ImageBitmap, which the page shows as a texture
// (see ./Live2DRuntime.ts, the page-side proxy).
//
// Why: drawn on the main thread, Cubism's per-frame work (and the GL state
// save/restore around every draw) filled the frame budget, and incoming mesh
// messages waited behind it (2026-10-04).
//
// The proprietary Core is fetched from the url the page passes (the page checks
// the user's license consent first; see ./coreLoader.ts) and evaluated as a
// classic script in this worker's global scope. Some framework modules read
// `Live2DCubismCore` enums at module-eval time, so they are imported only
// after the Core is in place.
// ---------------------------------------------------------------------------
import type { CubismUserModel } from '@cubism/framework/model/cubismusermodel';
import type { CubismRenderer_WebGL } from '@cubism/framework/rendering/cubismrenderer_webgl';
import type { CubismId } from '@cubism/framework/id/cubismid';
import type { Live2DToPage, PageToLive2D } from './live2dProtocol';

declare const self: DedicatedWorkerGlobalScope;

type FrameworkMods = {
  framework: typeof import('@cubism/framework/live2dcubismframework');
  settingJson: typeof import('@cubism/framework/cubismmodelsettingjson');
  userModel: typeof import('@cubism/framework/model/cubismusermodel');
  matrix: typeof import('@cubism/framework/math/cubismmatrix44');
};

let fwPromise: Promise<FrameworkMods> | null = null;

function loadFramework(coreUrl: string): Promise<FrameworkMods> {
  fwPromise ??= (async () => {
    const res = await fetch(coreUrl);
    if (!res.ok)
      throw new Error(`Live2D Cubism Core: fetch ${coreUrl} → ${res.status}`);
    // Indirect eval: global scope, so the Core's top-level `var` becomes a
    // global the framework can see.
    (0, eval)(await res.text());
    if (
      (self as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore ==
      null
    )
      throw new Error('Live2D Cubism Core evaluated but defined nothing');
    const [framework, settingJson, userModel, matrix] = await Promise.all([
      import('@cubism/framework/live2dcubismframework'),
      import('@cubism/framework/cubismmodelsettingjson'),
      import('@cubism/framework/model/cubismusermodel'),
      import('@cubism/framework/math/cubismmatrix44'),
    ]);
    framework.CubismFramework.startUp();
    framework.CubismFramework.initialize();
    return { framework, settingJson, userModel, matrix };
  })().catch((e) => {
    fwPromise = null; // a later load may retry
    throw e;
  });
  return fwPromise;
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Live2D: fetch ${url} → ${res.status}`);
  return res.arrayBuffer();
}

class WorkerModel {
  readonly canvas: OffscreenCanvas;
  readonly gl: WebGL2RenderingContext;
  model: CubismUserModel | null = null;
  disposed = false;
  private readonly idCache = new Map<string, CubismId>();

  constructor(
    private readonly fw: FrameworkMods,
    size: number
  ) {
    this.canvas = new OffscreenCanvas(size, size);
    const gl = this.canvas.getContext('webgl2', {
      premultipliedAlpha: true,
      alpha: true,
    });
    if (!gl) throw new Error('Live2D: WebGL2 unavailable in the worker');
    this.gl = gl;
  }

  async load(bundleUrl: string): Promise<void> {
    const fw = this.fw;
    const baseDir = bundleUrl.slice(0, bundleUrl.lastIndexOf('/') + 1);
    const settingBuf = await fetchArrayBuffer(bundleUrl);
    const setting = new fw.settingJson.CubismModelSettingJson(
      settingBuf,
      settingBuf.byteLength
    );
    const model = new fw.userModel.CubismUserModel();
    model.loadModel(
      await fetchArrayBuffer(baseDir + setting.getModelFileName())
    );
    // createRenderer's only argument is maskBufferCount (1 = framework default).
    model.createRenderer(1);
    const renderer = model.getRenderer();
    // Match the clipping mask buffer to the render target (the 256² default
    // softens masked drawables). Recreates the clipping manager, so it runs
    // before startUp(), which hands the GL context to the current one.
    renderer.setClippingMaskBufferSize(this.canvas.width);
    renderer.startUp(this.gl);
    renderer.setIsPremultipliedAlpha(true);
    await Promise.all(
      Array.from({ length: setting.getTextureCount() }, (_, i) =>
        this.loadTexture(renderer, i, baseDir + setting.getTextureFileName(i))
      )
    );
    if (this.disposed) {
      model.release();
      return;
    }
    this.model = model;
  }

  private async loadTexture(
    renderer: CubismRenderer_WebGL,
    index: number,
    url: string
  ): Promise<void> {
    const blob = await (await fetch(url)).blob();
    // WebGL ignores UNPACK_PREMULTIPLY_ALPHA for ImageBitmaps: premultiply
    // here instead, as the renderer expects (setIsPremultipliedAlpha above).
    const img = await createImageBitmap(blob, {
      premultiplyAlpha: 'premultiply',
    });
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('Live2D: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    img.close();
    renderer.bindTexture(index, tex);
  }

  params(): string[] {
    const m = this.model?.getModel();
    if (!m) return [];
    const out: string[] = [];
    // getString() returns a csmString wrapper; the JS string is on `.s`.
    for (let i = 0; i < m.getParameterCount(); i++)
      out.push(m.getParameterId(i).getString().s);
    return out;
  }

  setParam(id: string, value: number): void {
    if (!this.model) return;
    let handle = this.idCache.get(id);
    if (!handle) {
      handle = this.fw.framework.CubismFramework.getIdManager().getId(id);
      this.idCache.set(id, handle);
    }
    this.model.getModel().setParameterValueById(handle, value);
  }

  /** Apply this frame's parameters, draw, and hand the picture over. */
  frame(): ImageBitmap | null {
    if (this.disposed || !this.model) return null;
    this.model.getModel().update();
    const gl = this.gl;
    const renderer = this.model.getRenderer();
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    // Model space is ~[-1,1]; aspect-correct to the square target.
    const proj = new this.fw.matrix.CubismMatrix44();
    proj.loadIdentity();
    proj.scale(1, w / h);
    proj.multiplyByMatrix(this.model.getModelMatrix());
    renderer.setMvpMatrix(proj);
    // null fbo → the OffscreenCanvas's default framebuffer.
    renderer.setRenderState(null, [0, 0, w, h]);
    renderer.drawModel();
    return this.canvas.transferToImageBitmap();
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.model?.deleteRenderer();
      this.model?.release();
    } catch {
      /* best-effort */
    }
    this.model = null;
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

const models = new Map<number, WorkerModel>();

function post(msg: Live2DToPage, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function sendFrame(id: number, m: WorkerModel): void {
  const bitmap = m.frame();
  if (bitmap) post({ t: 'bitmap', id, bitmap }, [bitmap]);
}

self.onmessage = async (e: MessageEvent<PageToLive2D>) => {
  const msg = e.data;
  if (msg.t === 'load') {
    try {
      const fw = await loadFramework(msg.coreUrl);
      const m = new WorkerModel(fw, msg.size);
      models.set(msg.id, m);
      await m.load(msg.url);
      if (m.disposed) return;
      post({ t: 'loaded', id: msg.id, params: m.params() });
      sendFrame(msg.id, m); // so the page never shows an empty texture
    } catch (err) {
      models.get(msg.id)?.dispose();
      models.delete(msg.id);
      post({
        t: 'error',
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (msg.t === 'frame') {
    const m = models.get(msg.id);
    if (!m) return;
    for (const [pid, v] of msg.params) m.setParam(pid, v);
    sendFrame(msg.id, m);
  } else if (msg.t === 'dispose') {
    models.get(msg.id)?.dispose();
    models.delete(msg.id);
  }
};
