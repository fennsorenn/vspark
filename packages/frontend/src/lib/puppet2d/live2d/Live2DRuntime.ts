import * as THREE from 'three';
import { ensureCubismCore } from './coreLoader';
import type { Puppet2DRuntime } from '../types';
import type { CubismUserModel } from '@cubism/framework/model/cubismusermodel';
import type { CubismRenderer_WebGL } from '@cubism/framework/rendering/cubismrenderer_webgl';
import type { CubismId } from '@cubism/framework/id/cubismid';

// ---------------------------------------------------------------------------
// Live2DRuntime — the Cubism adapter for the Puppet2DRuntime interface.
//
// Renders a Live2D model into an off-screen WebGL canvas (its own GL context),
// exposed as a THREE.CanvasTexture for a scene-node plane. The Cubism Web
// Framework is vendored as a git submodule and consumed via the `@cubism/*`
// ambient boundary (see src/types/cubism-framework.d.ts); the proprietary Core
// is fetched at runtime by `ensureCubismCore` (never bundled).
//
// STATUS: implemented against the real submodule API (signatures verified) but
// NOT runtime-verified — this environment is headless. The spots most likely to
// need in-browser adjustment are marked `// VERIFY:`. On any failure the node
// falls back to its placeholder, so a runtime error never blanks the app.
// ---------------------------------------------------------------------------

type FrameworkMods = {
  framework: typeof import('@cubism/framework/live2dcubismframework');
  settingJson: typeof import('@cubism/framework/cubismmodelsettingjson');
  userModel: typeof import('@cubism/framework/model/cubismusermodel');
  matrix: typeof import('@cubism/framework/math/cubismmatrix44');
};

let started = false;
let fwPromise: Promise<FrameworkMods> | null = null;

/** Load the Core (global) THEN dynamically import the framework. Order matters:
 *  some framework modules read `Live2DCubismCore` enums at module-eval time. */
async function loadFramework(): Promise<FrameworkMods> {
  await ensureCubismCore();
  if (!fwPromise) {
    fwPromise = (async () => {
      const [framework, settingJson, userModel, matrix] = await Promise.all([
        import('@cubism/framework/live2dcubismframework'),
        import('@cubism/framework/cubismmodelsettingjson'),
        import('@cubism/framework/model/cubismusermodel'),
        import('@cubism/framework/math/cubismmatrix44'),
      ]);
      if (!started) {
        framework.CubismFramework.startUp();
        framework.CubismFramework.initialize();
        started = true;
      }
      return { framework, settingJson, userModel, matrix };
    })();
  }
  return fwPromise;
}

export class Live2DRuntime implements Puppet2DRuntime {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly texture: THREE.CanvasTexture;
  private fw: FrameworkMods | null = null;
  private model: CubismUserModel | null = null;
  private readonly idCache = new Map<string, CubismId>();
  private disposed = false;

  constructor(pixelWidth = 2048, pixelHeight = 2048) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    const gl = this.canvas.getContext('webgl2', {
      premultipliedAlpha: true,
      alpha: true,
    });
    if (!gl) throw new Error('Live2DRuntime: WebGL2 context unavailable');
    this.gl = gl;
    this.texture = new THREE.CanvasTexture(this.canvas);
    // VERIFY: flipY / premultiply may need flipping depending on Cubism output.
    this.texture.flipY = true;
    this.texture.premultiplyAlpha = true;
    // The canvas already renders at the target resolution; mip-chain sampling
    // only softens it. Keep it crisp.
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
  }

  async load(bundleUrl: string): Promise<void> {
    const fw = await loadFramework();
    if (this.disposed) return;
    this.fw = fw;
    const baseDir = bundleUrl.slice(0, bundleUrl.lastIndexOf('/') + 1);

    const settingBuf = await fetchArrayBuffer(bundleUrl);
    const setting = new fw.settingJson.CubismModelSettingJson(
      settingBuf,
      settingBuf.byteLength
    );

    const model = new fw.userModel.CubismUserModel();
    const mocBuf = await fetchArrayBuffer(baseDir + setting.getModelFileName());
    model.loadModel(mocBuf);
    // NB: createRenderer's only argument is maskBufferCount — the framework
    // ignores width/height. Passing the canvas size here previously requested
    // 1024 mask buffers; 1 is the framework default. The mask *resolution* is
    // set separately below.
    model.createRenderer(1);
    const renderer = model.getRenderer();
    renderer.startUp(this.gl);
    renderer.setIsPremultipliedAlpha(true);
    // Clipping masks default to a 256² buffer — far below the render target,
    // which makes masked drawables (eyes, mouth, often most of the face) look
    // downscaled-then-upscaled. Match the mask buffer to the canvas.
    renderer.setClippingMaskBufferSize(this.canvas.width);

    const texCount = setting.getTextureCount();
    await Promise.all(
      Array.from({ length: texCount }, (_, i) =>
        this.loadTexture(renderer, i, baseDir + setting.getTextureFileName(i))
      )
    );

    if (this.disposed) {
      model.release();
      return;
    }
    this.model = model;
  }

  private loadTexture(
    renderer: CubismRenderer_WebGL,
    index: number,
    url: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const gl = this.gl;
        const tex = gl.createTexture();
        if (!tex) {
          reject(new Error('Live2DRuntime: createTexture failed'));
          return;
        }
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MIN_FILTER,
          gl.LINEAR_MIPMAP_LINEAR
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          img
        );
        gl.generateMipmap(gl.TEXTURE_2D);
        renderer.bindTexture(index, tex);
        resolve();
      };
      img.onerror = () =>
        reject(new Error(`Live2DRuntime: texture load failed: ${url}`));
      img.src = url;
    });
  }

  listParams(): string[] {
    const m = this.model?.getModel();
    if (!m) return [];
    const out: string[] = [];
    const n = m.getParameterCount();
    // getString() returns a csmString wrapper; the JS string is on `.s`.
    for (let i = 0; i < n; i++) out.push(m.getParameterId(i).getString().s);
    return out;
  }

  setParam(id: string, value: number): void {
    if (!this.model || !this.fw) return;
    let handle = this.idCache.get(id);
    if (!handle) {
      handle = this.fw.framework.CubismFramework.getIdManager().getId(id);
      this.idCache.set(id, handle);
    }
    this.model.getModel().setParameterValueById(handle, value);
  }

  update(_dtSeconds: number): void {
    if (this.disposed || !this.model || !this.fw) return;
    // Params for this frame were set via setParam() before update(); apply them.
    this.model.getModel().update();
    this.renderFrame();
    this.texture.needsUpdate = true;
  }

  private renderFrame(): void {
    if (!this.model || !this.fw) return;
    const gl = this.gl;
    const renderer = this.model.getRenderer();
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);

    // VERIFY: projection fit. Model space is ~[-1,1]; aspect-correct to the
    // square target and compose the model matrix. Likely needs tuning per model.
    const proj = new this.fw.matrix.CubismMatrix44();
    proj.loadIdentity();
    proj.scale(1, w / h);
    proj.multiplyByMatrix(this.model.getModelMatrix());
    renderer.setMvpMatrix(proj);

    // null fbo → draw into the off-screen canvas's default framebuffer.
    renderer.setRenderState(null, [0, 0, w, h]);
    renderer.drawModel();
  }

  renderToTexture(): THREE.Texture {
    return this.texture;
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
    this.idCache.clear();
    this.texture.dispose();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Live2DRuntime: fetch ${url} → ${res.status}`);
  return res.arrayBuffer();
}
