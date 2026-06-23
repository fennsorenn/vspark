/// <reference lib="webworker" />
/**
 * MediaPipe inference worker (source).
 *
 * One bundle, two roles. The main thread spawns two instances of this worker:
 *   - role 'holistic' → HolisticLandmarker (face/pose/hand landmarks → markers)
 *   - role 'face'     → FaceLandmarker with blendshapes (the 52 ARKit shapes)
 * Running them as separate workers lets the (heavy) face model execute on its
 * own thread in parallel, so it doesn't drop the marker framerate. The
 * holistic_landmarker.task bundle does NOT ship the blendshapes model
 * (outputFaceBlendshapes is a silent no-op on it), which is why the face role
 * uses a dedicated FaceLandmarker.
 *
 * IMPORTANT: This file is NOT loaded by Vite directly. It's bundled into a CLASSIC IIFE
 * worker at `public/mediapipeWorker.js` by `scripts/build-mediapipe-worker.mjs`. The bundle
 * is checked into the repo so dev mode works without an extra build step.
 *
 * WHY A SEPARATE BUNDLE:
 *   MediaPipe's tasks-vision WASM loader requires `importScripts` (classic worker only).
 *   Vite serves workers as ESM modules in dev, and MediaPipe's WASM bootstrap fails with
 *   "ModuleFactory not set." Forcing `worker.format: 'iife'` works in production builds
 *   but is ignored by Vite's dev server. So we pre-bundle this file as a classic worker.
 *
 * REBUILDING:
 *   After editing this file, run:
 *     pnpm --filter @vspark/frontend build:worker
 *   The output `public/mediapipeWorker.js` must be committed alongside the source change.
 *
 * Communication contract (also typed in CameraCapture.ts):
 *   in:  { kind: 'init', role }
 *        { kind: 'frame', bitmap: ImageBitmap, timestamp: number }
 *        { kind: 'close' }
 *   out: { kind: 'ready' }
 *        { kind: 'error', message: string }
 *        { kind: 'result', result, timestamp }              // holistic role
 *        { kind: 'blendshapes', value, timestamp }          // face role
 */
import {
  FilesetResolver,
  HolisticLandmarker,
  FaceLandmarker,
} from '@mediapipe/tasks-vision';
import type { HolisticLandmarkerResult } from '@mediapipe/tasks-vision';

const WASM_CDN =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm';
const MODEL_CDN =
  'https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task';
const FACE_MODEL_CDN =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';

type Role = 'holistic' | 'face';

type InMsg =
  | { kind: 'init'; role: Role }
  | { kind: 'frame'; bitmap: ImageBitmap; timestamp: number }
  | { kind: 'close' };

type OutMsg =
  | { kind: 'ready' }
  | { kind: 'error'; message: string }
  | { kind: 'result'; result: HolisticLandmarkerResult; timestamp: number }
  | {
      kind: 'blendshapes';
      value: Record<string, number>;
      timestamp: number;
    };

let role: Role = 'holistic';
let landmarker: HolisticLandmarker | null = null;
let faceLandmarker: FaceLandmarker | null = null;

async function init(r: Role): Promise<void> {
  role = r;
  const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
  if (role === 'holistic') {
    landmarker = await HolisticLandmarker.createFromModelPath(vision, MODEL_CDN);
    await landmarker.setOptions({
      runningMode: 'VIDEO',
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minHandLandmarksConfidence: 0.5,
    });
  } else {
    // Dedicated face model purely for the 52 ARKit blendshapes (trained,
    // head-pose invariant). Its landmarks are unused — Holistic drives the head.
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODEL_CDN },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
  }
  (self as DedicatedWorkerGlobalScope).postMessage({
    kind: 'ready',
  } satisfies OutMsg);
}

function handleFrame(bitmap: ImageBitmap, timestamp: number): void {
  const post = (self as DedicatedWorkerGlobalScope).postMessage.bind(self);
  if (role === 'holistic') {
    if (!landmarker) {
      bitmap.close();
      return;
    }
    const result = landmarker.detectForVideo(bitmap, timestamp);
    bitmap.close();
    post({ kind: 'result', result, timestamp } satisfies OutMsg);
    return;
  }
  // face role
  if (!faceLandmarker) {
    bitmap.close();
    return;
  }
  const res = faceLandmarker.detectForVideo(bitmap, timestamp);
  bitmap.close();
  const value: Record<string, number> = {};
  const cats = res.faceBlendshapes?.[0]?.categories;
  if (cats) {
    for (const c of cats) {
      if (c.categoryName && c.categoryName !== '_neutral')
        value[c.categoryName] = c.score;
    }
  }
  post({ kind: 'blendshapes', value, timestamp } satisfies OutMsg);
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  try {
    if (msg.kind === 'init') {
      await init(msg.role);
      return;
    }
    if (msg.kind === 'frame') {
      handleFrame(msg.bitmap, msg.timestamp);
      return;
    }
    if (msg.kind === 'close') {
      await landmarker?.close();
      landmarker = null;
      await faceLandmarker?.close();
      faceLandmarker = null;
      return;
    }
  } catch (err) {
    console.error('[mediapipeWorker] error:', err);
    (self as DedicatedWorkerGlobalScope).postMessage({
      kind: 'error',
      message:
        err instanceof Error
          ? `${err.message}\n${err.stack ?? ''}`
          : String(err),
    } satisfies OutMsg);
  }
};
