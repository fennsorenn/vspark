import * as THREE from 'three';
import { cubismCoreUrl } from './coreLoader';
import type { Puppet2DRuntime } from '../types';
import type { Live2DToPage, PageToLive2D } from './live2dProtocol';

// ---------------------------------------------------------------------------
// Live2DRuntime — the Cubism adapter for the Puppet2DRuntime interface.
//
// The page-side half: the model itself loads, updates and draws in a worker
// (./live2d.worker.ts, one per page, shared by every Live2D node), off the
// main thread. This proxy forwards the parameters each frame and shows the
// pictures the worker sends back as a THREE texture for the node's plane.
//
// The Cubism Web Framework is vendored as a git submodule and consumed via the
// `@cubism/*` ambient boundary (see src/types/cubism-framework.d.ts); the
// proprietary Core is fetched at runtime, after license consent, by the worker
// (never bundled — see ./coreLoader.ts).
// ---------------------------------------------------------------------------

let worker: Worker | null = null;
let nextId = 1;
const instances = new Map<number, Live2DRuntime>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./live2d.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (e: MessageEvent<Live2DToPage>) => {
    const msg = e.data;
    const rt = instances.get(msg.id);
    if (!rt) {
      if (msg.t === 'bitmap') msg.bitmap.close();
      return;
    }
    rt.receive(msg);
  };
  return worker;
}

function send(msg: PageToLive2D): void {
  getWorker().postMessage(msg);
}

export class Live2DRuntime implements Puppet2DRuntime {
  private readonly id = nextId++;
  private readonly texture = new THREE.Texture();
  private params: string[] = [];
  /** Parameters set since the last frame was sent. */
  private readonly pending = new Map<string, number>();
  /** A frame is being drawn: wait for it rather than queue more behind it. */
  private inFlight = false;
  private loaded: {
    resolve: () => void;
    reject: (e: Error) => void;
  } | null = null;
  private disposed = false;

  constructor(private readonly size = 2048) {
    // ImageBitmaps upload as they are: WebGL ignores UNPACK_FLIP_Y for them,
    // so the plane samples the picture upside down instead (Cubism draws with
    // GL's bottom-up rows). Premultiplied already, as the worker's canvas is.
    this.texture.flipY = false;
    this.texture.repeat.set(1, -1);
    this.texture.offset.set(0, 1);
    // The picture is drawn at the target resolution; mip sampling would only
    // soften it.
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    instances.set(this.id, this);
  }

  /** Resolves once the model is loaded and its first picture has arrived. */
  load(bundleUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let coreUrl: string;
      try {
        coreUrl = cubismCoreUrl();
      } catch (e) {
        reject(e as Error);
        return;
      }
      this.loaded = { resolve, reject };
      this.inFlight = true; // the worker draws a first frame after loading
      send({
        t: 'load',
        id: this.id,
        url: bundleUrl,
        coreUrl,
        size: this.size,
      });
    });
  }

  /** A message from the worker for this model. */
  receive(msg: Live2DToPage): void {
    if (msg.t === 'loaded') {
      this.params = msg.params;
    } else if (msg.t === 'error') {
      this.inFlight = false;
      this.loaded?.reject(new Error(msg.message));
      this.loaded = null;
    } else {
      this.inFlight = false;
      if (this.disposed) {
        msg.bitmap.close();
        return;
      }
      const previous = this.texture.image as ImageBitmap | undefined;
      this.texture.image = msg.bitmap;
      this.texture.needsUpdate = true;
      previous?.close?.();
      this.loaded?.resolve();
      this.loaded = null;
    }
  }

  listParams(): string[] {
    return this.params;
  }

  setParam(id: string, value: number): void {
    this.pending.set(id, value);
  }

  /** Send this frame's parameters to be drawn (`dt` goes unused, as it did
   *  before the worker: the model's update takes none). While the previous
   *  frame is still being drawn, parameters wait for the next one: a slow
   *  frame never queues more work behind it. */
  update(_dtSeconds: number): void {
    if (this.disposed || this.inFlight || this.loaded) return;
    this.inFlight = true;
    send({ t: 'frame', id: this.id, params: [...this.pending] });
    this.pending.clear();
  }

  renderToTexture(): THREE.Texture {
    return this.texture;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    instances.delete(this.id);
    send({ t: 'dispose', id: this.id });
    (this.texture.image as ImageBitmap | undefined)?.close?.();
    this.texture.dispose();
    this.loaded?.reject(new Error('Live2DRuntime: disposed'));
    this.loaded = null;
  }
}
