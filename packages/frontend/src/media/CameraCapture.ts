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

import { HolisticLandmarker, DrawingUtils } from '@mediapipe/tasks-vision'
import type { HolisticLandmarkerResult } from '@mediapipe/tasks-vision'

export type { HolisticLandmarkerResult }

export interface LandmarkPoint {
  x: number
  y: number
  z: number
  visibility?: number
}

export type TrackingResult = {
  face?:      LandmarkPoint[]
  leftHand?:  LandmarkPoint[]
  rightHand?: LandmarkPoint[]
  pose?:      LandmarkPoint[]
}

export interface CameraCaptureOptions {
  enableFace?:  boolean
  enablePose?:  boolean
  enableHands?: boolean
}

const TARGET_FPS = 10
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS
// Low resolution: MediaPipe's models internally resize to ~256px regardless, so feeding 320×240
// gives the same detection quality with a fraction of the per-frame upload cost.
const CAMERA_WIDTH  = 320
const CAMERA_HEIGHT = 240

type WorkerInMsg =
  | { kind: 'init' }
  | { kind: 'frame'; bitmap: ImageBitmap; timestamp: number }
  | { kind: 'close' }

type WorkerOutMsg =
  | { kind: 'ready' }
  | { kind: 'error'; message: string }
  | { kind: 'result'; result: HolisticLandmarkerResult; timestamp: number }

export class CameraCapture {
  video: HTMLVideoElement | null = null
  private stream: MediaStream | null = null
  private worker: Worker | null = null
  private workerReady = false
  private busy = false
  private loopTimer: ReturnType<typeof setTimeout> | null = null
  private lastFrameAt = 0
  private _active = false
  lastRaw: HolisticLandmarkerResult | null = null

  onResult: ((result: TrackingResult) => void) | null = null
  onRawResult: ((r: HolisticLandmarkerResult) => void) | null = null
  onError:  ((err: Error) => void)          | null = null

  get active(): boolean { return this._active }

  async start(deviceId?: string, options: CameraCaptureOptions = {}): Promise<void> {
    await this.stop()

    // Load the worker as a classic script from /public. MediaPipe's WASM loader requires
    // importScripts to be available, which only works in classic (non-module) workers.
    this.worker = new Worker('/mediapipeWorker.js')
    this.worker.onmessage = (e: MessageEvent<WorkerOutMsg>) => this._onWorkerMessage(e.data, options)
    this.worker.onerror   = (e) => this.onError?.(new Error(`worker: ${e.message}`))
    this._postWorker({ kind: 'init' })

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: CAMERA_WIDTH, height: CAMERA_HEIGHT }
        : { width: CAMERA_WIDTH, height: CAMERA_HEIGHT },
    })

    this.video = document.createElement('video')
    this.video.srcObject = this.stream
    this.video.playsInline = true
    this.video.muted = true
    await this.video.play()
    this._active = true
    this._scheduleNext()
  }

  async stop(): Promise<void> {
    this._active = false
    if (this.loopTimer !== null) { clearTimeout(this.loopTimer); this.loopTimer = null }
    this.stream?.getTracks().forEach(t => t.stop())
    this.video?.remove()
    this._postWorker({ kind: 'close' })
    this.worker?.terminate()
    this.worker      = null
    this.workerReady = false
    this.busy        = false
    this.video       = null
    this.stream      = null
    this.lastRaw     = null
  }

  private _postWorker(msg: WorkerInMsg, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer)
  }

  private _scheduleNext(): void {
    if (!this._active) return
    const elapsed = performance.now() - this.lastFrameAt
    const wait = Math.max(0, FRAME_INTERVAL_MS - elapsed)
    this.loopTimer = setTimeout(() => this._tick(), wait)
  }

  private async _tick(): Promise<void> {
    this.loopTimer = null
    if (!this._active || !this.worker || !this.video) return
    if (!this.workerReady || this.busy) { this._scheduleNext(); return }
    if (this.video.readyState < 2)      { this._scheduleNext(); return }

    this.lastFrameAt = performance.now()
    this.busy = true
    try {
      const bitmap = await createImageBitmap(this.video)
      this._postWorker({ kind: 'frame', bitmap, timestamp: this.lastFrameAt }, [bitmap])
    } catch (e) {
      this.busy = false
      this.onError?.(e instanceof Error ? e : new Error(String(e)))
      this._scheduleNext()
    }
  }

  private _onWorkerMessage(msg: WorkerOutMsg, options: CameraCaptureOptions): void {
    if (msg.kind === 'ready') {
      this.workerReady = true
      return
    }
    if (msg.kind === 'error') {
      this.busy = false
      this.onError?.(new Error(msg.message))
      this._scheduleNext()
      return
    }
    if (msg.kind === 'result') {
      this.busy = false
      this._dispatch(msg.result, options)
      this._scheduleNext()
    }
  }

  private _dispatch(r: HolisticLandmarkerResult, opts: CameraCaptureOptions): void {
    this.lastRaw = r
    this.onRawResult?.(r)
    if (!this.onResult) return
    const out: TrackingResult = {}
    if (opts.enableFace !== false && r.faceLandmarks?.[0]?.length)
      out.face = r.faceLandmarks[0].map(p => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility }))
    if (opts.enablePose !== false && (r.poseWorldLandmarks?.[0]?.length ?? 0) > 0) {
      // Image-space visibility is reliable; world-space coords are more accurate.
      const imgVis = r.poseLandmarks?.[0]
      out.pose = r.poseWorldLandmarks[0].map((p, i) => ({
        x: p.x, y: p.y, z: p.z,
        visibility: imgVis?.[i]?.visibility ?? p.visibility,
      }))
    } else if (opts.enablePose !== false && r.poseLandmarks?.[0]?.length)
      out.pose = r.poseLandmarks[0].map(p => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility }))
    if (opts.enableHands !== false) {
      if (r.leftHandLandmarks?.[0]?.length)
        out.leftHand = r.leftHandLandmarks[0].map(p => ({ x: p.x, y: p.y, z: p.z }))
      if (r.rightHandLandmarks?.[0]?.length)
        out.rightHand = r.rightHandLandmarks[0].map(p => ({ x: p.x, y: p.y, z: p.z }))
    }
    this.onResult(out)
  }

  static async getDevices(): Promise<MediaDeviceInfo[]> {
    await navigator.mediaDevices.getUserMedia({ video: true }).catch(() => null)
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter(d => d.kind === 'videoinput')
  }

  /** Draw landmarks onto a canvas synchronously. Call after drawImage(). */
  static drawLandmarksSync(ctx: CanvasRenderingContext2D, result: HolisticLandmarkerResult): void {
    try {
      const draw = new DrawingUtils(ctx)
      if (result.faceLandmarks?.[0]) {
        draw.drawConnectors(result.faceLandmarks[0], HolisticLandmarker.FACE_LANDMARKS_LIPS, { color: '#E0E0E0', lineWidth: 1 })
        draw.drawLandmarks(result.faceLandmarks[0], { color: '#30FF55', lineWidth: 1, radius: 1 })
      }
      if (result.poseLandmarks?.[0]) {
        draw.drawConnectors(result.poseLandmarks[0], HolisticLandmarker.POSE_CONNECTIONS, { color: '#00FF7F', lineWidth: 2 })
      }
      if (result.leftHandLandmarks?.[0]) {
        draw.drawConnectors(result.leftHandLandmarks[0], HolisticLandmarker.HAND_CONNECTIONS, { color: '#CC0000', lineWidth: 2 })
      }
      if (result.rightHandLandmarks?.[0]) {
        draw.drawConnectors(result.rightHandLandmarks[0], HolisticLandmarker.HAND_CONNECTIONS, { color: '#00CC00', lineWidth: 2 })
      }
    } catch { /* non-fatal */ }
  }
}
