import * as THREE from 'three';

/**
 * Per-bone filter for broadcast (tracking) bone rotations in the viewport.
 *
 * One pass that covers what used to be two stacked filters (a One Euro jitter
 * filter followed by optional second-order "snappiness"), so each purpose can be
 * set on its own without paying both filters' lag:
 *
 * - **Interpolation** (always on): tracking poses arrive at 10–60 Hz while the
 *   viewport renders at the display rate. With no smoothing the filter glides
 *   onto each new pose in about one pose interval (`glideHz`, measured from the
 *   incoming samples), so the avatar doesn't step and gets as little extra lag as
 *   possible.
 * - **Smoothing** (`smoothing`, `adaptation`): lowers the follow frequency when
 *   the input is nearly still, to absorb jitter; it rises again with the input's
 *   angular speed (One Euro style), so fast moves stay crisp. The frequency never
 *   exceeds `glideHz`.
 * - **Spring** (`damping`, `response`): damping below 1 overshoots, response
 *   above 0 reacts to the input's velocity (anticipation), below 0 winds up.
 *
 * The core is a second-order (spring–damper) system in the semi-implicit-Euler
 * formulation of t3ssel8r ("Giving Personality to Procedural Animations using
 * Math"), on SO(3): spring error, target velocity and output velocity are
 * world-frame rotation vectors; the orientation integrates through the
 * quaternion exponential map. The target velocity (and the speed that drives
 * the adaptation) is estimated per input SAMPLE and held in between, not per
 * rendered frame, where a stepped input would look like a spike followed by
 * zeros.
 */
export type PoseFilterPreset = 'minimal' | 'smooth' | 'springy' | 'custom';

export interface PoseFilterParams {
  /** 0 = no smoothing (interpolation only) … 1 = heavy smoothing at rest. */
  smoothing: number;
  /** Follow-frequency increase per rad/s of input speed (Hz·s/rad). */
  adaptation: number;
  /** Damping ratio ζ: <1 overshoots, 1 critical, >1 sluggish. */
  damping: number;
  /** Response r: 0 none, >0 anticipation, <0 wind-up. */
  response: number;
}

export interface PoseFilterConfig extends PoseFilterParams {
  preset: PoseFilterPreset;
}

export const POSE_FILTER_PRESETS: Record<
  Exclude<PoseFilterPreset, 'custom'>,
  PoseFilterParams
> = {
  minimal: { smoothing: 0, adaptation: 0, damping: 1, response: 0 },
  // Tuned offline (2026-11-23) against the old One Euro filter (min cutoff 1 Hz,
  // beta 0.3): no more jitter at rest, less lag on steps and swings.
  smooth: { smoothing: 0.9, adaptation: 3, damping: 1, response: 0 },
  // About 6° overshoot on a 50° step. Smoothing at rest stays high: with less,
  // the spring answers jitter; it fades with speed, so moves stay quick.
  springy: { smoothing: 0.9, adaptation: 1, damping: 0.7, response: 1 },
};

/** Owner decision 2026-11-23: every avatar starts at Minimal. */
export const DEFAULT_POSE_FILTER: PoseFilterConfig = {
  preset: 'minimal',
  ...POSE_FILTER_PRESETS.minimal,
};

/** Parameter ranges (the properties panel's sliders and the schema). */
export const POSE_FILTER_RANGES = {
  smoothing: { min: 0, max: 1 },
  adaptation: { min: 0, max: 6 },
  damping: { min: 0.1, max: 3 },
  response: { min: -2, max: 4 },
} as const;

/** The parameters in effect: a preset's own values unless it is 'custom'. */
export function resolvePoseFilter(
  cfg?: Partial<PoseFilterConfig> | null
): PoseFilterConfig {
  const preset = cfg?.preset ?? DEFAULT_POSE_FILTER.preset;
  if (preset !== 'custom' && preset in POSE_FILTER_PRESETS)
    return { preset, ...POSE_FILTER_PRESETS[preset] };
  return { ...DEFAULT_POSE_FILTER, ...cfg, preset: 'custom' };
}

/** Glide (no smoothing): settles ~95% within one pose interval. A critically
 *  damped system settles to 95% in ≈ 4.74 / ω, so f = 4.74 / (2π · interval). */
const GLIDE_CYCLES = 4.74 / (2 * Math.PI);
const GLIDE_MIN_HZ = 2;
const GLIDE_MAX_HZ = 30;
/** Follow frequency at rest with full smoothing. */
const REST_MIN_HZ = 0.5;
/** Time constants (s) of the sample-interval and input-speed estimates. */
const INTERVAL_TAU = 0.5;
const SPEED_TAU = 0.15;
/** Before the first interval is measured. */
const DEFAULT_INTERVAL = 1 / 30;
/** Gaps longer than this don't count as the pose rate: the viewport flags a
 *  sample as new only when its values change, so a held pose (or a tracking
 *  pause) looks like one long interval, and would slow the glide to a crawl
 *  right when movement resumes. */
const MAX_SAMPLE_GAP = 0.25;
/** A held target velocity is dropped once no sample has come for this long
 *  (or twice the last interval, if longer): the input stopped. */
const STALL_SECONDS = 0.1;
const EPS = 1e-8;

const _rel = new THREE.Quaternion();

/** Rotation vector (axis·angle, rad) of `a * b⁻¹`, shortest arc. */
function relRotVec(
  out: THREE.Vector3,
  a: THREE.Quaternion,
  b: THREE.Quaternion
): THREE.Vector3 {
  _rel.copy(b).invert().premultiply(a);
  let { x, y, z, w } = _rel;
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  const vlen = Math.sqrt(x * x + y * y + z * z);
  if (vlen < EPS) return out.set(0, 0, 0);
  const s = (2 * Math.atan2(vlen, w)) / vlen;
  return out.set(x * s, y * s, z * s);
}

/** Quaternion exponential of the rotation vector `w·dt`. */
function rotVecToQuat(
  out: THREE.Quaternion,
  w: THREE.Vector3,
  dt: number
): THREE.Quaternion {
  const ax = w.x * dt;
  const ay = w.y * dt;
  const az = w.z * dt;
  const angle = Math.sqrt(ax * ax + ay * ay + az * az);
  if (angle < EPS) return out.set(0, 0, 0, 1);
  const s = Math.sin(angle / 2) / angle;
  return out.set(ax * s, ay * s, az * s, Math.cos(angle / 2));
}

/** The filter for one bone. */
export class PoseFilterQuat {
  private initialized = false;
  private readonly y = new THREE.Quaternion(); // output
  private readonly xPrev = new THREE.Quaternion(); // previous sample
  private readonly w = new THREE.Vector3(); // output angular velocity (rad/s)
  private readonly wx = new THREE.Vector3(); // target angular velocity, per sample
  private readonly wxs = new THREE.Vector3(); // the same, smoothed (SPEED_TAU)
  private sinceSample = 0;
  private lastInterval = 0;
  private interval = DEFAULT_INTERVAL; // smoothed sample interval (s)
  private readonly err = new THREE.Vector3();
  private readonly dq = new THREE.Quaternion();
  /** Follow frequency used in the last step (Hz), for tests and debugging. */
  lastFrequency = 0;

  /** Glide frequency for the measured pose rate. */
  get glideHz(): number {
    return Math.min(
      GLIDE_MAX_HZ,
      Math.max(GLIDE_MIN_HZ, GLIDE_CYCLES / this.interval)
    );
  }

  /**
   * Advance one frame toward target `x`. Returns the internal output
   * quaternion — copy it before calling again. `newSample`: `x` is new input
   * this frame (not the same pose again); callers feeding a fresh sample every
   * frame can leave it `true`.
   */
  filter(
    x: THREE.Quaternion,
    dt: number,
    p: PoseFilterParams,
    newSample = true
  ): THREE.Quaternion {
    if (dt <= 0) return this.y;
    if (!this.initialized) {
      this.y.copy(x);
      this.xPrev.copy(x);
      this.w.set(0, 0, 0);
      this.wx.set(0, 0, 0);
      this.wxs.set(0, 0, 0);
      this.sinceSample = 0;
      this.lastInterval = 0;
      this.initialized = true;
      return this.y;
    }

    // Per-sample estimates: target velocity, input speed, sample interval.
    this.sinceSample += dt;
    if (newSample) {
      const iv = this.sinceSample;
      relRotVec(this.wx, x, this.xPrev).multiplyScalar(1 / iv);
      this.xPrev.copy(x);
      if (iv <= MAX_SAMPLE_GAP)
        this.interval +=
          (1 - Math.exp(-iv / INTERVAL_TAU)) * (iv - this.interval);
      this.wxs.lerp(this.wx, 1 - Math.exp(-iv / SPEED_TAU));
      this.lastInterval = iv;
      this.sinceSample = 0;
    } else if (
      this.sinceSample > Math.max(STALL_SECONDS, 2 * this.lastInterval)
    ) {
      this.wx.set(0, 0, 0);
      this.wxs.multiplyScalar(Math.exp(-dt / SPEED_TAU));
    }

    // Follow frequency: glide, lowered by smoothing at rest, raised with speed.
    const glide = this.glideHz;
    const s = Math.min(1, Math.max(0, p.smoothing));
    const rest = glide * Math.pow(REST_MIN_HZ / glide, s);
    const f = Math.min(
      glide,
      rest + Math.max(0, p.adaptation) * this.wxs.length()
    );
    this.lastFrequency = f;

    const wn = 2 * Math.PI * f;
    const k1 = p.damping / (Math.PI * f);
    const k2 = 1 / (wn * wn);
    const k3 = (p.response * p.damping) / wn;
    // Keep semi-implicit Euler stable at large dt (low frame rates).
    const k2s = Math.max(k2, (dt * dt) / 2 + (dt * k1) / 2, dt * k1);

    relRotVec(this.err, x, this.y);
    // The response term uses the smoothed target velocity: a raw per-sample
    // velocity of a noisy input would turn jitter into amplified jitter.
    const v = this.wxs;
    this.w.x += (dt * (this.err.x + k3 * v.x - k1 * this.w.x)) / k2s;
    this.w.y += (dt * (this.err.y + k3 * v.y - k1 * this.w.y)) / k2s;
    this.w.z += (dt * (this.err.z + k3 * v.z - k1 * this.w.z)) / k2s;
    rotVecToQuat(this.dq, this.w, dt);
    this.y.copy(this.dq.multiply(this.y)).normalize();
    return this.y;
  }

  reset(): void {
    this.initialized = false;
    this.w.set(0, 0, 0);
    this.wx.set(0, 0, 0);
    this.wxs.set(0, 0, 0);
  }
}

/** One filter per named bone, created on first use. */
export class PoseFilterBank {
  private readonly filters = new Map<string, PoseFilterQuat>();

  filter(
    boneName: string,
    x: THREE.Quaternion,
    dt: number,
    p: PoseFilterParams,
    newSample = true
  ): THREE.Quaternion {
    let f = this.filters.get(boneName);
    if (!f) this.filters.set(boneName, (f = new PoseFilterQuat()));
    return f.filter(x, dt, p, newSample);
  }

  reset(): void {
    this.filters.forEach((f) => f.reset());
  }
}
