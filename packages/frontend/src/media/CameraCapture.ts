/**
 * CameraCapture — browser camera → MediaPipe HolisticLandmarker → landmark arrays.
 *
 * Runs detection in video mode using a hidden <video> element.
 * Results are delivered via callback at the camera's native frame rate.
 * Only landmark arrays are produced here — conversion to bones/blendshapes
 * happens on the backend signal graph.
 */

import { FilesetResolver, HolisticLandmarker } from '@mediapipe/tasks-vision'
import type { HolisticLandmarkerResult } from '@mediapipe/tasks-vision'

export type { HolisticLandmarkerResult }

// Landmark as we transmit it (matches shared Landmark interface)
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

const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm'
const MODEL_CDN = 'https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task'

export class CameraCapture {
  private landmarker: HolisticLandmarker | null = null
  private video: HTMLVideoElement | null = null
  private stream: MediaStream | null = null
  private rafId: number | null = null
  private _active = false

  onResult: ((result: TrackingResult) => void) | null = null
  onError:  ((err: Error) => void)          | null = null

  get active(): boolean { return this._active }

  async start(deviceId?: string, options: CameraCaptureOptions = {}): Promise<void> {
    await this.stop()

    // Load WASM + model (cached after first load)
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN)
    this.landmarker = await HolisticLandmarker.createFromModelPath(vision, MODEL_CDN)
    await this.landmarker.setOptions({
      runningMode:        'VIDEO',
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence:  0.5,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence:  0.5,
      minHandLandmarksConfidence: 0.5,
    })

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId }, width: 640, height: 480 } : { width: 640, height: 480 },
    })

    this.video = document.createElement('video')
    this.video.srcObject = this.stream
    this.video.playsInline = true
    this.video.muted = true
    await this.video.play()
    this._active = true
    this._loop(options)
  }

  async stop(): Promise<void> {
    this._active = false
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null }
    this.stream?.getTracks().forEach(t => t.stop())
    this.video?.remove()
    await this.landmarker?.close()
    this.landmarker = null
    this.video = null
    this.stream = null
  }

  private _loop(options: CameraCaptureOptions): void {
    if (!this._active || !this.landmarker || !this.video) return
    if (this.video.readyState >= 2) {
      try {
        const result = this.landmarker.detectForVideo(this.video, performance.now())
        this._dispatch(result, options)
      } catch (e) {
        this.onError?.(e instanceof Error ? e : new Error(String(e)))
      }
    }
    this.rafId = requestAnimationFrame(() => this._loop(options))
  }

  private _dispatch(r: HolisticLandmarkerResult, opts: CameraCaptureOptions): void {
    if (!this.onResult) return
    const out: TrackingResult = {}
    if (opts.enableFace !== false && r.faceLandmarks?.[0]?.length)
      out.face = r.faceLandmarks[0].map(p => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility }))
    if (opts.enablePose !== false && r.poseWorldLandmarks?.[0]?.length)
      out.pose = r.poseWorldLandmarks[0].map(p => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility }))
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

  /** Draw landmarks onto a canvas using MediaPipe's drawing utils. */
  static async drawLandmarks(canvas: HTMLCanvasElement, result: HolisticLandmarkerResult): Promise<void> {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { DrawingUtils } = await import('@mediapipe/tasks-vision')
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
  }
}
