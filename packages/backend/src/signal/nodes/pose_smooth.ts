import { SignalNode, NormalizedPose, Quaternion } from '@vspark/shared/signal';
import type { VRMBoneName, BoneConfidence } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';

/** Lag (seconds) at confidence 0; it falls off quadratically to none at confidence 1. */
const DEFAULT_MAX_LAG = 0.6;
/** Time constant (seconds) for a bone's confidence to climb back after a drop. */
const DEFAULT_RISE_TIME = 0.3;
/** A bone missing for longer than this starts from scratch when it returns. */
const FORGET_MS = 1000;

const clamp = (x: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, x));

interface BoneTrack {
  q: Quaternion;
  conf: number;
  seenAt: number;
}

/**
 * Confidence-weighted pose smoothing. Each bone eases toward its incoming rotation with a lag
 * that grows as its confidence drops — a fully confident bone passes straight through (the
 * frontend applies its own jitter filter), an unreliable one (e.g. a landmark MediaPipe can only
 * estimate) drifts slowly instead of jumping.
 *
 * Confidence drops take effect at once, but climb back over `riseTime`, so a bone whose tracking
 * returns eases into the new reading instead of snapping to it. A bone that reappears within
 * `FORGET_MS` resumes from where it was, at confidence 0.
 */
@SignalNode({
  label: 'Pose Smooth',
  description:
    'Eases each bone toward its tracked rotation with a lag that grows as its confidence (0–1) drops. Confident bones pass through; unreliable ones drift instead of jumping. maxLag = lag in seconds at confidence 0, riseTime = how long confidence takes to recover after a drop.',
  tags: ['mocap'],
  color: '#4a7a6a',
})
export class PoseSmooth extends Node {
  static readonly kind = 'pose_smooth';

  @valueIn('pose', 'NormalizedPose') poseIn!: () => NormalizedPose | undefined;
  @valueIn('confidence', 'BoneConfidence') confidenceIn!: () =>
    | BoneConfidence
    | undefined;
  @valueIn('maxLag', 'Float') maxLagIn!: () => number | undefined;
  @valueIn('riseTime', 'Float') riseTimeIn!: () => number | undefined;

  private readonly _tracks = new Map<VRMBoneName, BoneTrack>();
  private _lastAt = 0;
  /** Memo so multiple pulls in one frame integrate exactly once. */
  private _memoFor: NormalizedPose | null = null;
  private _memo: NormalizedPose | null = null;

  @valueOut('pose', 'NormalizedPose')
  pose = (): NormalizedPose | undefined => {
    const pose = this.poseIn();
    if (!pose) return undefined;
    if (this._memoFor === pose && this._memo) return this._memo;

    const confidence = this.confidenceIn() ?? {};
    const maxLag = Math.max(0, this.maxLagIn() ?? DEFAULT_MAX_LAG);
    const riseTime = Math.max(0, this.riseTimeIn() ?? DEFAULT_RISE_TIME);

    const now = Date.now();
    const dt =
      this._lastAt === 0 ? 0 : clamp((now - this._lastAt) / 1000, 0, 0.5);
    this._lastAt = now;

    const out = pose.map((q, bone) => {
      const target = clamp(confidence[bone] ?? 1, 0, 1);
      const prev = this._tracks.get(bone);
      if (!prev || now - prev.seenAt > FORGET_MS) {
        this._tracks.set(bone, { q, conf: target, seenAt: now });
        return q;
      }
      // Drops land at once; recovery is eased.
      const conf =
        target <= prev.conf || riseTime === 0
          ? target
          : prev.conf + (target - prev.conf) * (1 - Math.exp(-dt / riseTime));
      const lag = maxLag * (1 - conf) * (1 - conf);
      const next = lag <= 1e-4 ? q : prev.q.slerp(q, 1 - Math.exp(-dt / lag));
      this._tracks.set(bone, { q: next, conf, seenAt: now });
      return next;
    });

    // A bone that went missing resumes at confidence 0 when it returns (if not yet forgotten).
    for (const track of this._tracks.values()) {
      if (track.seenAt !== now) track.conf = 0;
    }

    this._memoFor = pose;
    this._memo = out;
    return out;
  };
}
