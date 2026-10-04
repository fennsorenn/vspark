// Messages between the page (./Live2DRuntime.ts) and the Live2D worker
// (./live2d.worker.ts). One worker hosts every model of the page, by id.

export type PageToLive2D =
  | {
      t: 'load';
      id: number;
      /** The model's `*.model3.json`; siblings resolve relative to it. */
      url: string;
      /** The Cubism Core script (fetched only after license consent). */
      coreUrl: string;
      /** Render target edge, px (square). */
      size: number;
    }
  /** This frame's parameters: draw and send the picture back. */
  | { t: 'frame'; id: number; params: [string, number][] }
  | { t: 'dispose'; id: number };

export type Live2DToPage =
  | { t: 'loaded'; id: number; params: string[] }
  | { t: 'error'; id: number; message: string }
  | { t: 'bitmap'; id: number; bitmap: ImageBitmap };
