/**
 * Provider B — in-process CPU inference, no browser.
 *
 * Runs `@vladmandic/human` on `@tensorflow/tfjs-node` inside the server process. The point
 * is scheduling behaviour, not raw speed: because the backend *is* the inference process,
 * it can raise its own priority and cap its own thread count, neither of which is possible
 * against a Chromium that self-demotes its renderers. Measured cost is roughly one core
 * (thread-capping to 1 costs ~11% throughput — the pipeline is largely sequential).
 *
 * ── Loaded lazily and optionally ──────────────────────────────────────────────────────
 * tfjs-node is ~830 MB installed and breaks the single-`bundle.cjs` release model, so it
 * is an optionalDependency resolved through `createRequire` at runtime. A variable
 * specifier keeps esbuild from trying to resolve it at bundle time, so the default build,
 * install and release are unaffected when it is absent — `probe()` simply reports the
 * provider unavailable.
 *
 * ── Known unverified area ─────────────────────────────────────────────────────────────
 * Human's body keypoints are pixel-space, while the backend's arm converters were written
 * against MediaPipe's *world* landmarks (metric, hip-centred). The mapping below
 * approximates that by hip-centring and normalising to shoulder width. That approximation
 * has NOT been validated against a real camera — it is the first thing to check when
 * comparing pose quality between the two providers.
 */

import { createRequire } from 'module';
import os from 'os';
import {
  FFT_SIZE,
  DEFAULT_TEMPLATES,
  buildMelFilters,
  computeMfcc,
  emptyVisemeWeights,
  analyserPowerSpectrum,
  prepareTemplates,
  rmsOf,
  updateVisemeWeights,
  type PreparedTemplates,
  type VowelTemplates,
} from '@vspark/shared/mfcc';
import { estimateArkitBlendshapes } from '@vspark/shared/face_heuristic';
import type { Landmark } from '@vspark/shared';
import type {
  CaptureDevice,
  CaptureKind,
  CaptureLandmarkFrame,
  CaptureProvider,
  CaptureProviderStatus,
  CaptureRequest,
  CaptureSink,
} from '../types.js';
import { openAudioStream, openVideoStream, probeFfmpeg } from './ffmpeg.js';

/** Variable specifiers — see the header: this is what keeps esbuild from bundling them. */
const HUMAN_PKG = '@vladmandic/human';
const HUMAN_MODELS_PKG = '@vladmandic/human-models';
const TFJS_NODE_PKG = '@tensorflow/tfjs-node';

const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 480;
/** Inference cadence. Resolution barely affects cost (the models resize internally), so
 *  this — not frame size — is the CPU dial. */
const TARGET_FPS = 12;
const AUDIO_SAMPLE_RATE = 48000;
const LIPSYNC_FPS = 30;

interface HumanKeypoint {
  part?: string;
  position: number[];
  positionRaw?: number[];
}
interface HumanResult {
  face: { mesh?: number[][]; meshRaw?: number[][] }[];
  body: { keypoints: HumanKeypoint[] }[];
  hand: { label?: string; keypoints: number[][]; landmarks?: unknown }[];
}
interface HumanInstance {
  load(): Promise<void>;
  detect(input: unknown): Promise<HumanResult>;
  tf: { node: { decodeImage(b: Buffer, c: number): unknown }; dispose(t: unknown): void };
}

/** BlazePose landmark indices used for the world-space approximation. */
const LEFT_HIP = 23;
const RIGHT_HIP = 24;
const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;

interface Session {
  behaviorId: string;
  kind: CaptureKind;
  close: () => void;
}

export class NodeInferenceProvider implements CaptureProvider {
  readonly id = 'node_inference' as const;
  readonly kinds: CaptureKind[] = ['tracking', 'lipsync'];

  private readonly sessions = new Map<string, Session>();
  private human: HumanInstance | null = null;
  private humanLoading: Promise<HumanInstance> | null = null;
  private probed: { available: boolean; detail: string | null } | null = null;
  private lastError: string | null = null;

  constructor(private readonly sink: CaptureSink) {}

  async probe(): Promise<{ available: boolean; detail: string | null }> {
    if (this.probed) return this.probed;
    const require_ = createRequire(import.meta.url);
    const missing: string[] = [];
    for (const pkg of [TFJS_NODE_PKG, HUMAN_PKG, HUMAN_MODELS_PKG]) {
      try {
        require_.resolve(pkg);
      } catch {
        missing.push(pkg);
      }
    }
    if (missing.length) {
      this.probed = {
        available: false,
        detail: `optional dependencies not installed: ${missing.join(', ')} — run "pnpm --filter @vspark/backend install:node-inference"`,
      };
      return this.probed;
    }
    const ff = await probeFfmpeg();
    if (!ff.ok) {
      this.probed = { available: false, detail: ff.detail };
      return this.probed;
    }
    this.probed = { available: true, detail: ff.detail };
    return this.probed;
  }

  /**
   * Thread cap + priority: the two levers a Chromium agent cannot offer. Capping intra-op
   * threads keeps inference from spreading across every core next to a game; the priority
   * bump is what keeps it scheduled when the game is greedy.
   */
  private applyResourcePolicy(): void {
    const threads = process.env.VSPARK_CAPTURE_THREADS ?? '2';
    process.env.TF_NUM_INTRAOP_THREADS ??= threads;
    process.env.TF_NUM_INTEROP_THREADS ??= threads;
    const nice = Number(process.env.VSPARK_CAPTURE_PRIORITY ?? '-5');
    if (!Number.isNaN(nice)) {
      try {
        os.setPriority(0, nice);
      } catch (e) {
        console.warn(
          `[capture/node_inference] could not raise priority: ${
            e instanceof Error ? e.message : String(e)
          }`
        );
      }
    }
  }

  private async loadHuman(): Promise<HumanInstance> {
    if (this.human) return this.human;
    if (this.humanLoading) return this.humanLoading;
    this.applyResourcePolicy();
    this.humanLoading = (async () => {
      const require_ = createRequire(import.meta.url);
      // tfjs-node must be required before Human so the 'tensorflow' backend registers.
      require_(TFJS_NODE_PKG);
      const mod = require_(HUMAN_PKG) as { default?: unknown; Human?: unknown };
      const Ctor = (mod.default ?? mod.Human) as new (cfg: unknown) => HumanInstance;
      const modelsDir = require_
        .resolve(`${HUMAN_MODELS_PKG}/package.json`)
        .replace(/package\.json$/, 'models');
      const human = new Ctor({
        backend: 'tensorflow',
        modelBasePath: `file://${modelsDir}`,
        // Lean config: mesh+iris gives the 478-point topology the shared face heuristic
        // needs; attention roughly doubles cost for accuracy we don't consume.
        face: {
          enabled: true,
          detector: { rotation: false },
          mesh: { enabled: true },
          iris: { enabled: true },
          attention: { enabled: false },
          description: { enabled: false },
          emotion: { enabled: false },
          antispoof: { enabled: false },
          liveness: { enabled: false },
        },
        body: { enabled: true, modelPath: 'blazepose-lite.json' },
        hand: { enabled: true, maxDetected: 2 },
        object: { enabled: false },
        gesture: { enabled: false },
        segmentation: { enabled: false },
      });
      await human.load();
      this.human = human;
      return human;
    })();
    return this.humanLoading;
  }

  async start(req: CaptureRequest): Promise<void> {
    await this.stop(req.behaviorId);
    if (req.kind === 'tracking') await this.startTracking(req);
    else await this.startLipsync(req);
  }

  private async startTracking(req: CaptureRequest): Promise<void> {
    const human = await this.loadHuman();
    let busy = false;

    const stream = openVideoStream(
      {
        width: CAPTURE_WIDTH,
        height: CAPTURE_HEIGHT,
        fps: TARGET_FPS,
        deviceId: req.deviceId,
      },
      (rgb) => {
        // Drop frames while an inference is in flight rather than queueing them: a
        // backlog would turn a transient CPU stall into permanent latency.
        if (busy) return;
        busy = true;
        void this.inferFrame(human, rgb, req)
          .catch((e) => {
            this.lastError = e instanceof Error ? e.message : String(e);
            this.sink.error(req.behaviorId, e instanceof Error ? e : new Error(String(e)));
          })
          .finally(() => {
            busy = false;
          });
      },
      (err) => {
        this.lastError = err.message;
        this.sink.error(req.behaviorId, err);
      }
    );

    this.sessions.set(req.behaviorId, {
      behaviorId: req.behaviorId,
      kind: 'tracking',
      close: () => stream.close(),
    });
  }

  private async inferFrame(
    human: HumanInstance,
    rgb: Buffer,
    req: CaptureRequest
  ): Promise<void> {
    // Wrap the raw RGB in a minimal PNG-free path: Human accepts a tensor, and tfjs-node
    // can build one directly from the packed buffer without an encode/decode round-trip.
    const tf = human.tf as unknown as {
      tensor3d(data: Uint8Array, shape: number[], dtype: string): unknown;
      dispose(t: unknown): void;
    };
    const tensor = tf.tensor3d(
      new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.length),
      [CAPTURE_HEIGHT, CAPTURE_WIDTH, 3],
      'int32'
    );
    try {
      const res = await human.detect(tensor);
      const frame = this.toLandmarkFrame(res, req.config);
      if (frame) this.sink.landmarks(req.behaviorId, frame);
    } finally {
      tf.dispose(tensor);
    }
  }

  /** Map Human's output onto the same shape the browser uplinks. */
  private toLandmarkFrame(
    res: HumanResult,
    config: Record<string, unknown>
  ): CaptureLandmarkFrame | null {
    const out: CaptureLandmarkFrame = {};
    const wantFace = config.enableFace !== false;
    const wantPose = config.enablePose !== false;
    const wantHands = config.enableHands !== false;

    const face = res.face?.[0];
    if (wantFace && face?.mesh?.length) {
      // Normalised to 0..1 like the browser's landmarks. The face heuristic is
      // scale-invariant (it divides by the eye-corner reference), but the head-pose
      // converter reads these directly, so the ranges must match.
      const mesh: Landmark[] = face.mesh.map((p) => ({
        x: p[0] / CAPTURE_WIDTH,
        y: p[1] / CAPTURE_HEIGHT,
        z: (p[2] ?? 0) / CAPTURE_WIDTH,
      }));
      out.face = mesh;
      if (mesh.length >= 478) out.faceBlendshapes = estimateArkitBlendshapes(mesh);
    }

    const body = res.body?.[0];
    if (wantPose && body?.keypoints?.length) {
      out.pose = this.toWorldish(body.keypoints);
    }

    if (wantHands && res.hand?.length) {
      for (const h of res.hand) {
        if (!h.keypoints?.length) continue;
        const pts: Landmark[] = h.keypoints.map((p) => ({
          x: p[0] / CAPTURE_WIDTH,
          y: p[1] / CAPTURE_HEIGHT,
          z: (p[2] ?? 0) / CAPTURE_WIDTH,
        }));
        // The frame is already mirrored by ffmpeg's hflip, matching the browser path, so
        // Human's left/right labels line up with the performer's own left/right.
        if (h.label === 'left') out.leftHand = pts;
        else if (h.label === 'right') out.rightHand = pts;
      }
    }

    return out.face || out.pose || out.leftHand || out.rightHand ? out : null;
  }

  /**
   * Approximate MediaPipe's `poseWorldLandmarks` from Human's pixel-space keypoints:
   * translate to the hip midpoint and scale so shoulder width is ~unit. This is an
   * approximation of a metric space, not the real thing — see the file header.
   */
  private toWorldish(keypoints: HumanKeypoint[]): Landmark[] {
    const at = (i: number) => keypoints[i]?.position ?? [0, 0, 0];
    const lh = at(LEFT_HIP);
    const rh = at(RIGHT_HIP);
    const ls = at(LEFT_SHOULDER);
    const rs = at(RIGHT_SHOULDER);
    const ox = (lh[0] + rh[0]) / 2;
    const oy = (lh[1] + rh[1]) / 2;
    const oz = ((lh[2] ?? 0) + (rh[2] ?? 0)) / 2;
    const shoulderWidth = Math.hypot(ls[0] - rs[0], ls[1] - rs[1]) || CAPTURE_WIDTH / 4;
    // MediaPipe world landmarks put shoulder width near ~0.3 m; matching that keeps the
    // downstream shoulder-scaling maths in the same numeric range it was tuned for.
    const scale = 0.3 / shoulderWidth;
    return keypoints.map((k) => ({
      x: (k.position[0] - ox) * scale,
      y: (k.position[1] - oy) * scale,
      z: ((k.position[2] ?? 0) - oz) * scale,
      visibility: 1,
    }));
  }

  private async startLipsync(req: CaptureRequest): Promise<void> {
    const templates =
      (req.config.vowelTemplates as VowelTemplates | undefined) ?? DEFAULT_TEMPLATES;
    let prepared: PreparedTemplates;
    try {
      prepared = prepareTemplates(templates);
    } catch {
      prepared = prepareTemplates(DEFAULT_TEMPLATES);
    }
    const melFilters = buildMelFilters(AUDIO_SAMPLE_RATE, FFT_SIZE);
    const weights = emptyVisemeWeights();
    let lastSent = 0;

    const stream = openAudioStream(
      { sampleRate: AUDIO_SAMPLE_RATE, frameSize: FFT_SIZE, deviceId: req.deviceId },
      (samples) => {
        // Identical DSP to the browser: analyserPowerSpectrum reproduces AnalyserNode's
        // Blackman window and normalisation, so calibrated templates stay valid.
        const power = analyserPowerSpectrum(samples);
        const mfcc = computeMfcc(power, melFilters);
        updateVisemeWeights(weights, mfcc, rmsOf(samples), prepared);
        const now = Date.now();
        if (now - lastSent < 1000 / LIPSYNC_FPS) return;
        lastSent = now;
        this.sink.visemes(req.behaviorId, { ...weights });
      },
      (err) => {
        this.lastError = err.message;
        this.sink.error(req.behaviorId, err);
      }
    );

    this.sessions.set(req.behaviorId, {
      behaviorId: req.behaviorId,
      kind: 'lipsync',
      close: () => stream.close(),
    });
  }

  async stop(behaviorId: string): Promise<void> {
    const session = this.sessions.get(behaviorId);
    if (!session) return;
    this.sessions.delete(behaviorId);
    session.close();
  }

  /**
   * ffmpeg device *names* are platform-native and enumerating them differs per OS, so this
   * intentionally returns nothing rather than half-working guesses: the user supplies a
   * native identifier (a dshow device name, `/dev/videoN`, an avfoundation index) via the
   * behaviour's `deviceId`. Empty means "system default".
   */
  async listDevices(): Promise<CaptureDevice[]> {
    return [];
  }

  status(): CaptureProviderStatus {
    return {
      id: this.id,
      available: this.probed?.available ?? false,
      detail: this.lastError ?? this.probed?.detail ?? null,
      running: [...this.sessions.keys()],
    };
  }

  async close(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.stop(id);
    this.human = null;
    this.humanLoading = null;
  }
}
