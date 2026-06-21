/**
 * CameraCapture — browser camera → MediaPipe HolisticLandmarker (in a Worker) → landmark arrays.
 *
 * The heavy inference runs in a Web Worker so it doesn't drop the editor's render framerate.
 * Main thread owns the <video> element and timing; it grabs frames as ImageBitmaps and posts
 * them transferably to the worker. Worker posts results back.
 *
 * Inference is throttled to TARGET_FPS to cap CPU/GPU cost; the editor uses landmarks at this
 * cadence (interpolation/smoothing happens downstream in the signal graph).
 */

import { HolisticLandmarker, DrawingUtils } from '@mediapipe/tasks-vision';
import type { HolisticLandmarkerResult } from '@mediapipe/tasks-vision';

export type { HolisticLandmarkerResult };

export interface LandmarkPoint {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export type TrackingResult = {
  face?: LandmarkPoint[];
  leftHand?: LandmarkPoint[];
  rightHand?: LandmarkPoint[];
  pose?: LandmarkPoint[];
  /** ARKit blendshape weights (shape name → 0..1) from MediaPipe's face model. */
  faceBlendshapes?: Record<string, number>;
};

export interface CameraCaptureOptions {
  enableFace?: boolean;
  enablePose?: boolean;
  enableHands?: boolean;
}

const TARGET_FPS = 10;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
// Low resolution: MediaPipe's models internally resize to ~256px regardless, so feeding 320×240
// gives the same detection quality with a fraction of the per-frame upload cost.
const CAMERA_WIDTH = 320;
const CAMERA_HEIGHT = 240;

type WorkerInMsg =
  | { kind: 'init'; role: 'holistic' | 'face' }
  | { kind: 'frame'; bitmap: ImageBitmap; timestamp: number }
  | { kind: 'close' };

type WorkerOutMsg =
  | { kind: 'ready' }
  | { kind: 'error'; message: string }
  | { kind: 'result'; result: HolisticLandmarkerResult; timestamp: number }
  | { kind: 'blendshapes'; value: Record<string, number>; timestamp: number };

export class CameraCapture {
  video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  // Holistic (markers) and face (blendshapes) run as separate workers so the
  // heavier face model executes in parallel without dropping the marker rate.
  private worker: Worker | null = null;
  private workerReady = false;
  private busy = false;
  private faceWorker: Worker | null = null;
  private faceReady = false;
  private faceBusy = false;
  /** Latest blendshapes from the face worker, attached to each marker dispatch. */
  private latestBlendshapes: Record<string, number> | null = null;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFrameAt = 0;
  private _active = false;
  private flipCanvas: OffscreenCanvas | null = null;
  private flipCtx: OffscreenCanvasRenderingContext2D | null = null;
  /** TEMP: throttle timestamp for the blendshape diagnostic log. */
  private static _bsLog = 0;
  lastRaw: HolisticLandmarkerResult | null = null;

  onResult: ((result: TrackingResult) => void) | null = null;
  onRawResult: ((r: HolisticLandmarkerResult) => void) | null = null;
  onError: ((err: Error) => void) | null = null;

  get active(): boolean {
    return this._active;
  }

  async start(
    deviceId?: string,
    options: CameraCaptureOptions = {}
  ): Promise<void> {
    await this.stop();

    // Load the worker as a classic script from /public. MediaPipe's WASM loader requires
    // importScripts to be available, which only works in classic (non-module) workers.
    // Two instances of the same bundle: one runs Holistic (markers), one runs the
    // FaceLandmarker (blendshapes), so the heavy face model parallelizes.
    this.worker = new Worker('/mediapipeWorker.js');
    this.worker.onmessage = (e: MessageEvent<WorkerOutMsg>) =>
      this._onHolisticMessage(e.data, options);
    this.worker.onerror = (e) =>
      this.onError?.(new Error(`worker: ${e.message}`));
    this._postWorker(this.worker, { kind: 'init', role: 'holistic' });

    this.faceWorker = new Worker('/mediapipeWorker.js');
    this.faceWorker.onmessage = (e: MessageEvent<WorkerOutMsg>) =>
      this._onFaceMessage(e.data);
    this.faceWorker.onerror = (e) =>
      this.onError?.(new Error(`face worker: ${e.message}`));
    this._postWorker(this.faceWorker, { kind: 'init', role: 'face' });

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId
        ? {
            deviceId: { exact: deviceId },
            width: CAMERA_WIDTH,
            height: CAMERA_HEIGHT,
          }
        : { width: CAMERA_WIDTH, height: CAMERA_HEIGHT },
    });

    this.video = document.createElement('video');
    this.video.srcObject = this.stream;
    this.video.playsInline = true;
    this.video.muted = true;
    await this.video.play();
    this._active = true;
    this._scheduleNext();
  }

  async stop(): Promise<void> {
    this._active = false;
    if (this.loopTimer !== null) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video?.remove();
    if (this.worker) this._postWorker(this.worker, { kind: 'close' });
    if (this.faceWorker) this._postWorker(this.faceWorker, { kind: 'close' });
    this.worker?.terminate();
    this.faceWorker?.terminate();
    this.worker = null;
    this.faceWorker = null;
    this.workerReady = false;
    this.faceReady = false;
    this.busy = false;
    this.faceBusy = false;
    this.latestBlendshapes = null;
    this.video = null;
    this.stream = null;
    this.lastRaw = null;
  }

  private _postWorker(
    worker: Worker,
    msg: WorkerInMsg,
    transfer: Transferable[] = []
  ): void {
    worker.postMessage(msg, transfer);
  }

  private _scheduleNext(): void {
    if (!this._active) return;
    const elapsed = performance.now() - this.lastFrameAt;
    const wait = Math.max(0, FRAME_INTERVAL_MS - elapsed);
    this.loopTimer = setTimeout(() => this._tick(), wait);
  }

  private async _tick(): Promise<void> {
    this.loopTimer = null;
    if (!this._active || !this.video) return;
    const holisticFree = !!this.worker && this.workerReady && !this.busy;
    const faceFree = !!this.faceWorker && this.faceReady && !this.faceBusy;
    if (this.video.readyState < 2 || (!holisticFree && !faceFree)) {
      this._scheduleNext();
      return;
    }

    this.lastFrameAt = performance.now();
    const ts = this.lastFrameAt;
    try {
      // Draw the mirror once, then hand a fresh bitmap to each free worker so
      // markers (holistic) and blendshapes (face) run in parallel, each at its
      // own rate. A busy worker is simply skipped this tick.
      const src = this._drawMirror(this.video);
      if (holisticFree && this.worker) {
        const bitmap = await createImageBitmap(src);
        this.busy = true;
        this._postWorker(this.worker, { kind: 'frame', bitmap, timestamp: ts }, [
          bitmap,
        ]);
      }
      if (faceFree && this.faceWorker) {
        const bitmap = await createImageBitmap(src);
        this.faceBusy = true;
        this._postWorker(
          this.faceWorker,
          { kind: 'frame', bitmap, timestamp: ts },
          [bitmap]
        );
      }
    } catch (e) {
      this.busy = false;
      this.faceBusy = false;
      this.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
    this._scheduleNext();
  }

  /**
   * Draw a horizontally-mirrored (selfie) frame into the reused offscreen canvas and return the
   * source to snapshot. The whole downstream pipeline — MediaPipe's hand-handedness classifier,
   * the pose left/right convention, the head frame — is written for the mirrored convention, and
   * the preview is shown mirrored too. Feeding the raw (un-mirrored) frame is what made
   * arms/hands/head come out reflected.
   */
  private _drawMirror(
    video: HTMLVideoElement
  ): HTMLVideoElement | OffscreenCanvas {
    const w = video.videoWidth || CAMERA_WIDTH;
    const h = video.videoHeight || CAMERA_HEIGHT;
    if (!this.flipCanvas) {
      this.flipCanvas = new OffscreenCanvas(w, h);
      this.flipCtx = this.flipCanvas.getContext('2d');
    }
    if (this.flipCanvas.width !== w) this.flipCanvas.width = w;
    if (this.flipCanvas.height !== h) this.flipCanvas.height = h;
    const ctx = this.flipCtx;
    if (!ctx) return video; // fallback: unmirrored
    ctx.setTransform(-1, 0, 0, 1, w, 0); // mirror across the vertical axis
    ctx.drawImage(video, 0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0); // reset for next frame
    return this.flipCanvas;
  }

  private _onHolisticMessage(
    msg: WorkerOutMsg,
    options: CameraCaptureOptions
  ): void {
    if (msg.kind === 'ready') {
      this.workerReady = true;
      return;
    }
    if (msg.kind === 'error') {
      this.busy = false;
      this.onError?.(new Error(msg.message));
      return;
    }
    if (msg.kind === 'result') {
      this.busy = false;
      this._dispatch(msg.result, options);
    }
  }

  private _onFaceMessage(msg: WorkerOutMsg): void {
    if (msg.kind === 'ready') {
      this.faceReady = true;
      return;
    }
    if (msg.kind === 'error') {
      this.faceBusy = false;
      this.onError?.(new Error(msg.message));
      return;
    }
    if (msg.kind === 'blendshapes') {
      this.faceBusy = false;
      this.latestBlendshapes = Object.keys(msg.value).length
        ? msg.value
        : null;
    }
  }

  private _dispatch(
    r: HolisticLandmarkerResult,
    opts: CameraCaptureOptions
  ): void {
    this.lastRaw = r;
    this.onRawResult?.(r);
    // TEMP diagnostic: blendshapes (from the parallel face worker) flowing?
    // Throttled to once every ~2s. Remove once confirmed.
    if (performance.now() - CameraCapture._bsLog > 2000) {
      CameraCapture._bsLog = performance.now();
      const bs = this.latestBlendshapes;
      const top = bs
        ? Object.entries(bs)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([k, v]) => `${k}=${v.toFixed(2)}`)
            .join(', ')
        : '(none)';
      console.info(
        `[blendshapes] faceLandmarks=${r.faceLandmarks?.[0]?.length ?? 0} ` +
          `blendshapes=${bs ? Object.keys(bs).length : 0} top: ${top}`
      );
    }
    if (!this.onResult) return;
    const out: TrackingResult = {};
    if (opts.enableFace !== false && r.faceLandmarks?.[0]?.length)
      out.face = r.faceLandmarks[0].map((p) => ({
        x: p.x,
        y: p.y,
        z: p.z,
        visibility: p.visibility,
      }));
    // Native ARKit blendshapes (category name → score) from the parallel face
    // worker; latest value is attached to every marker frame.
    if (opts.enableFace !== false && this.latestBlendshapes)
      out.faceBlendshapes = this.latestBlendshapes;
    if (
      opts.enablePose !== false &&
      (r.poseWorldLandmarks?.[0]?.length ?? 0) > 0
    ) {
      // Image-space visibility is reliable; world-space coords are more accurate.
      const imgVis = r.poseLandmarks?.[0];
      out.pose = r.poseWorldLandmarks[0].map((p, i) => ({
        x: p.x,
        y: p.y,
        z: p.z,
        visibility: imgVis?.[i]?.visibility ?? p.visibility,
      }));
    } else if (opts.enablePose !== false && r.poseLandmarks?.[0]?.length)
      out.pose = r.poseLandmarks[0].map((p) => ({
        x: p.x,
        y: p.y,
        z: p.z,
        visibility: p.visibility,
      }));
    if (opts.enableHands !== false) {
      // The frame fed to MediaPipe is mirrored (selfie) in `_tick`, which is the convention its
      // hand-handedness classifier assumes — so leftHandLandmarks is the performer's true left
      // hand, consistent with the pose/arm landmarks. No swap needed here.
      if (r.leftHandLandmarks?.[0]?.length)
        out.leftHand = r.leftHandLandmarks[0].map((p) => ({
          x: p.x,
          y: p.y,
          z: p.z,
        }));
      if (r.rightHandLandmarks?.[0]?.length)
        out.rightHand = r.rightHandLandmarks[0].map((p) => ({
          x: p.x,
          y: p.y,
          z: p.z,
        }));
    }
    this.onResult(out);
  }

  static async getDevices(): Promise<MediaDeviceInfo[]> {
    await navigator.mediaDevices
      .getUserMedia({ video: true })
      .catch(() => null);
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  /**
   * Per-tracker overlay colours. Each landmark group (face / pose / left hand / right hand)
   * gets a clearly distinct hue so it's obvious which tracker is feeding which bones — e.g.
   * whether the hands are coming from hand tracking (red/green) or being inferred from the
   * pose skeleton (blue).
   */
  static readonly OVERLAY_COLORS = {
    face: '#FFD000', // yellow
    pose: '#2E9BFF', // blue
    leftHand: '#FF3B3B', // red
    rightHand: '#22DD22', // green
  } as const;

  /**
   * Draw landmarks onto a canvas synchronously. Call after drawImage().
   * `labels`, if given, draws a colour legend in the top-left corner.
   */
  static drawLandmarksSync(
    ctx: CanvasRenderingContext2D,
    result: HolisticLandmarkerResult,
    labels?: { face: string; pose: string; leftHand: string; rightHand: string }
  ): void {
    const C = CameraCapture.OVERLAY_COLORS;
    try {
      const draw = new DrawingUtils(ctx);
      if (result.faceLandmarks?.[0]) {
        draw.drawConnectors(
          result.faceLandmarks[0],
          HolisticLandmarker.FACE_LANDMARKS_LIPS,
          { color: C.face, lineWidth: 1 }
        );
        draw.drawLandmarks(result.faceLandmarks[0], {
          color: C.face,
          lineWidth: 1,
          radius: 0.8,
        });
      }
      if (result.poseLandmarks?.[0]) {
        draw.drawConnectors(
          result.poseLandmarks[0],
          HolisticLandmarker.POSE_CONNECTIONS,
          { color: C.pose, lineWidth: 2 }
        );
        draw.drawLandmarks(result.poseLandmarks[0], {
          color: C.pose,
          lineWidth: 1,
          radius: 2,
        });
      }
      for (const [hand, color] of [
        [result.leftHandLandmarks?.[0], C.leftHand],
        [result.rightHandLandmarks?.[0], C.rightHand],
      ] as const) {
        if (!hand) continue;
        draw.drawConnectors(hand, HolisticLandmarker.HAND_CONNECTIONS, {
          color,
          lineWidth: 2,
        });
        draw.drawLandmarks(hand, { color, lineWidth: 1, radius: 2 });
      }
      if (labels) CameraCapture._drawLegend(ctx, labels);
    } catch {
      /* non-fatal */
    }
  }

  private static _drawLegend(
    ctx: CanvasRenderingContext2D,
    labels: { face: string; pose: string; leftHand: string; rightHand: string }
  ): void {
    const C = CameraCapture.OVERLAY_COLORS;
    const rows: [string, string][] = [
      [C.face, labels.face],
      [C.pose, labels.pose],
      [C.leftHand, labels.leftHand],
      [C.rightHand, labels.rightHand],
    ];
    const fs = Math.max(10, Math.round(ctx.canvas.height * 0.05));
    const pad = Math.round(fs * 0.5);
    const lh = fs + pad;
    const sw = fs; // colour swatch size
    let maxText = 0;
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    for (const [, text] of rows)
      maxText = Math.max(maxText, ctx.measureText(text).width);
    const boxW = pad + sw + pad * 0.6 + maxText + pad;
    const boxH = pad + rows.length * lh;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(pad, pad, boxW, boxH);
    rows.forEach(([color, text], i) => {
      const y = pad + pad / 2 + i * lh + lh / 2;
      ctx.fillStyle = color;
      ctx.fillRect(pad + pad, y - sw / 2, sw, sw);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, pad + pad + sw + pad * 0.6, y);
    });
    ctx.restore();
  }
}
