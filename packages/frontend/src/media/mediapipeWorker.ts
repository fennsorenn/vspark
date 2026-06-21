/// <reference lib="webworker" />
/**
 * MediaPipe Holistic inference worker (source).
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
 *   in:  { kind: 'init' }
 *        { kind: 'frame', bitmap: ImageBitmap, timestamp: number }
 *        { kind: 'close' }
 *   out: { kind: 'ready' }
 *        { kind: 'error', message: string }
 *        { kind: 'result', result: HolisticLandmarkerResult, timestamp: number }
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
// The holistic_landmarker.task bundle does NOT ship the face-blendshapes model
// (outputFaceBlendshapes is silently a no-op on it), so we run a dedicated
// FaceLandmarker — which does include it — alongside Holistic and merge its
// blendshapes into the result.
const FACE_MODEL_CDN =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';

type InMsg =
  | { kind: 'init' }
  | { kind: 'frame'; bitmap: ImageBitmap; timestamp: number }
  | { kind: 'close' };

type OutMsg =
  | { kind: 'ready' }
  | { kind: 'error'; message: string }
  | { kind: 'result'; result: HolisticLandmarkerResult; timestamp: number };

let landmarker: HolisticLandmarker | null = null;
let faceLandmarker: FaceLandmarker | null = null;

async function init(): Promise<void> {
  const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
  landmarker = await HolisticLandmarker.createFromModelPath(vision, MODEL_CDN);
  await landmarker.setOptions({
    runningMode: 'VIDEO',
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minHandLandmarksConfidence: 0.5,
  });
  // Dedicated face model purely for the 52 ARKit blendshapes (trained,
  // head-pose invariant). Its landmarks are unused — Holistic drives the head.
  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: FACE_MODEL_CDN },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
  });
  (self as DedicatedWorkerGlobalScope).postMessage({
    kind: 'ready',
  } satisfies OutMsg);
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  try {
    if (msg.kind === 'init') {
      await init();
      return;
    }
    if (msg.kind === 'frame') {
      if (!landmarker) {
        msg.bitmap.close();
        return;
      }
      const result = landmarker.detectForVideo(msg.bitmap, msg.timestamp);
      // Same frame through the face model; graft its blendshapes onto the
      // holistic result so downstream code reads them off `result.faceBlendshapes`.
      if (faceLandmarker) {
        const faceRes = faceLandmarker.detectForVideo(
          msg.bitmap,
          msg.timestamp
        );
        result.faceBlendshapes = faceRes.faceBlendshapes;
      }
      msg.bitmap.close();
      (self as DedicatedWorkerGlobalScope).postMessage({
        kind: 'result',
        result,
        timestamp: msg.timestamp,
      } satisfies OutMsg);
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
