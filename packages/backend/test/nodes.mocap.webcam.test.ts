/**
 * nodes.mocap.webcam.test.ts
 *
 * Temporal regression tests for the MediaPipe arm solve (pose_arms_to_bones → pose_smooth) on real
 * webcam frames. test/fixtures/mediapipe/webcam_arm_clips.json holds four 25-frame (~2.5s) clips
 * of HolisticLandmarker output as CameraCapture sent it, picked from a recording as the windows
 * where the previous solve (which rolled the whole arm to the hand and split that roll 50/50
 * between upper arm and forearm) jumped hardest:
 *
 *   twist_flip_a / twist_flip_b — hand tracked, forearm toward the camera; the old 50/50 roll split
 *                                 flipped sides frame to frame (24 and 17 of 25 frames jumped >45°)
 *   hand_dropouts               — hand tracking dropping in and out
 *   wrist_low_vis               — wrist visibility hovering around 0.5 (the old solve dropped the
 *                                 forearm and hand below 0.5)
 *
 * The bounds are what the current solve achieves with some headroom, not ideals: hand-model noise
 * (it can alternate between two readings of the same hand with the fingers toward the camera) is
 * still visible in the forearm and hand.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkEvent, NormalizedPose, Quaternion } from '@vspark/shared/signal';
import type { VRMBoneName } from '@vspark/shared/signal';
import { buildGraph } from './helpers/nodeHarness.js';
import { getAllNodeKindMeta } from '../src/signal/registry.js';
import {
  ARM_SOLVE_SWITCHES,
  MEDIAPIPE_PIPELINE_TEMPLATE,
} from '../src/behaviors/mediapipe_tracker/graph.js';

type L = { x: number; y: number; z: number; visibility?: number };
type Clip = {
  side: 'left' | 'right';
  frames: {
    t: number;
    pose: number[][];
    leftHand: number[][] | null;
    rightHand: number[][] | null;
  }[];
};

const FIX = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/mediapipe'
);
const CLIPS: Record<string, Clip> = JSON.parse(
  fs.readFileSync(path.join(FIX, 'webcam_arm_clips.json'), 'utf8')
).clips;

const inflate = (a: number[][] | null): L[] | undefined =>
  a?.map((p) => ({
    x: p[0],
    y: p[1],
    z: p[2],
    ...(p.length > 3 ? { visibility: p[3] } : {}),
  }));

const angleDeg = (a: Quaternion, b: Quaternion): number =>
  (2 *
    Math.acos(
      Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w))
    ) *
    180) /
  Math.PI;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Run a clip through the real engine, one pull per frame, with Date.now on the clip's clock. */
function runClip(
  clip: Clip,
  smooth: boolean,
  options: Record<string, unknown> = {}
): NormalizedPose[] {
  // pose_smooth's own inputs go to the smoother, everything else to pose_arms_to_bones.
  const SMOOTH_KEYS = [
    'enabled',
    'jumpHold',
    'holdDeg',
    'holdFrames',
    'maxLag',
    'riseTime',
  ];
  const armsCfg: Record<string, unknown> = {};
  const smoothCfg: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options))
    (SMOOTH_KEYS.includes(k) ? smoothCfg : armsCfg)[k] = v;
  const nodes = [
    { id: 'arms', kind: 'pose_arms_to_bones' },
    { id: 'trg', kind: 'component_trigger' },
    { id: 'sink', kind: 'log' },
  ];
  const edges = [
    {
      fromNodeId: 'trg',
      fromPort: 'trigger',
      toNodeId: 'sink',
      toPort: 'trigger',
    },
  ];
  if (smooth) {
    nodes.push({ id: 'smooth', kind: 'pose_smooth' });
    edges.push(
      {
        fromNodeId: 'arms',
        fromPort: 'pose',
        toNodeId: 'smooth',
        toPort: 'pose',
      },
      {
        fromNodeId: 'arms',
        fromPort: 'confidence',
        toNodeId: 'smooth',
        toPort: 'confidence',
      },
      {
        fromNodeId: 'smooth',
        fromPort: 'pose',
        toNodeId: 'sink',
        toPort: 'inputs',
      }
    );
  } else {
    edges.push({
      fromNodeId: 'arms',
      fromPort: 'pose',
      toNodeId: 'sink',
      toPort: 'inputs',
    });
  }
  const { graph } = buildGraph(nodes, edges, {
    arms: armsCfg,
    smooth: smoothCfg,
  });
  const out: NormalizedPose[] = [];
  for (const f of clip.frames) {
    // The engine reads unconnected value inputs from config on every pull.
    armsCfg.pose = inflate(f.pose);
    armsCfg.leftHand = inflate(f.leftHand);
    armsCfg.rightHand = inflate(f.rightHand);
    vi.setSystemTime(1_000_000 + f.t);
    graph.fire('trg', 'trigger', mkEvent(undefined));
    out.push((graph.peekInput('sink', 'inputs') as NormalizedPose[])[0]);
  }
  return out;
}

/** Frame-to-frame rotation of one bone (frames where it is missing are skipped). */
function jumps(poses: NormalizedPose[], bone: string): number[] {
  const out: number[] = [];
  let prev: Quaternion | undefined;
  for (const p of poses) {
    const q = p.get(bone as VRMBoneName);
    if (q && prev) out.push(angleDeg(q, prev));
    if (q) prev = q;
  }
  return out;
}

describe('pose_arms_to_bones on recorded webcam clips', () => {
  for (const name of ['twist_flip_a', 'twist_flip_b', 'hand_dropouts']) {
    it(`keeps the upper arm's roll steady (${name})`, () => {
      const clip = CLIPS[name];
      const poses = runClip(clip, false);
      // The upper arm's roll comes from the shoulder–elbow–wrist plane, not from the hand, so
      // neither hand noise nor hand dropouts reach it.
      expect(Math.max(...jumps(poses, `${clip.side}UpperArm`))).toBeLessThan(
        45
      );
    });
  }

  it('keeps solving the forearm and hand while the wrist is only estimated', () => {
    const clip = CLIPS.wrist_low_vis;
    const poses = runClip(clip, true);
    for (const p of poses)
      expect(p.has(`${clip.side}LowerArm` as VRMBoneName)).toBe(true);
    // Low-visibility bones are eased by pose_smooth instead of jumping (raw max: 67° / 115°).
    expect(Math.max(...jumps(poses, `${clip.side}LowerArm`))).toBeLessThan(40);
    expect(Math.max(...jumps(poses, `${clip.side}Hand`))).toBeLessThan(35);
  });

  it('smooths at least half of the large forearm jumps across hand dropouts', () => {
    const clip = CLIPS.hand_dropouts;
    const big = (smooth: boolean) =>
      jumps(runClip(clip, smooth), `${clip.side}LowerArm`).filter((d) => d > 45)
        .length;
    expect(big(true)).toBeLessThanOrEqual(big(false) / 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Geometry: the elbow hinge near a straight arm
// ─────────────────────────────────────────────────────────────────────────────

describe('pose_arms_to_bones elbow hinge', () => {
  /** A 33-point pose with both arms hanging; the left wrist is moved by `wrist`. */
  function hangingPose(wrist: { x: number; y: number; z: number }): L[] {
    const pts: L[] = Array.from({ length: 33 }, () => ({
      x: 0,
      y: 0,
      z: 0,
      visibility: 1,
    }));
    // MediaPipe frame: +X toward the `left` side, +Y down, +Z away from the camera.
    pts[11] = { x: 0.2, y: -0.5, z: 0, visibility: 1 }; // left shoulder
    pts[12] = { x: -0.2, y: -0.5, z: 0, visibility: 1 }; // right shoulder
    pts[13] = { x: 0.2, y: -0.2, z: 0, visibility: 1 }; // left elbow
    pts[14] = { x: -0.2, y: -0.2, z: 0, visibility: 1 };
    pts[15] = { ...wrist, visibility: 1 }; // left wrist
    pts[16] = { x: -0.2, y: 0.1, z: 0, visibility: 1 };
    pts[23] = { x: 0.1, y: 0, z: 0, visibility: 1 };
    pts[24] = { x: -0.1, y: 0, z: 0, visibility: 1 };
    return pts;
  }
  const solve = (wrist: { x: number; y: number; z: number }) => {
    const { graph } = buildGraph(
      [
        { id: 'arms', kind: 'pose_arms_to_bones' },
        { id: 'trg', kind: 'component_trigger' },
        { id: 'sink', kind: 'log' },
      ],
      [
        {
          fromNodeId: 'arms',
          fromPort: 'pose',
          toNodeId: 'sink',
          toPort: 'inputs',
        },
        {
          fromNodeId: 'trg',
          fromPort: 'trigger',
          toNodeId: 'sink',
          toPort: 'trigger',
        },
      ],
      { arms: { pose: hangingPose(wrist) } }
    );
    graph.fire('trg', 'trigger', mkEvent(undefined));
    return (graph.peekInput('sink', 'inputs') as NormalizedPose[])[0];
  };

  it('does not flip the upper arm as a nearly straight elbow bends slightly either way', () => {
    // Wrist ~3° in front of vs ~3° behind the shoulder→elbow line: the bend plane's normal flips,
    // but the upper arm must barely move.
    const front = solve({ x: 0.2, y: 0.1, z: -0.016 });
    const back = solve({ x: 0.2, y: 0.1, z: 0.016 });
    expect(
      angleDeg(front.get('leftUpperArm')!, back.get('leftUpperArm')!)
    ).toBeLessThan(5);
  });

  it('takes the upper arm roll from the elbow plane once the elbow is bent', () => {
    // Forearm forward vs forearm sideways (outward): same upper arm direction, different plane, so
    // the upper arm rolls by the angle between the two planes (90°).
    const forward = solve({ x: 0.2, y: -0.2, z: -0.3 });
    const outward = solve({ x: 0.5, y: -0.2, z: 0 });
    expect(
      angleDeg(forward.get('leftUpperArm')!, outward.get('leftUpperArm')!)
    ).toBeCloseTo(90, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pose_smooth
// ─────────────────────────────────────────────────────────────────────────────

describe('pose_smooth', () => {
  const Q90 = Quaternion.fromEuler(0, Math.PI / 2, 0);
  const I = Quaternion.IDENTITY;

  // The confidence-lag tests step by 90° in one frame, which the jump hold would hold back.
  function smoother(extra: Record<string, unknown> = { jumpHold: false }) {
    const cfg: Record<string, unknown> = { ...extra };
    const { graph } = buildGraph(
      [
        { id: 's', kind: 'pose_smooth' },
        { id: 'trg', kind: 'component_trigger' },
        { id: 'sink', kind: 'log' },
      ],
      [
        {
          fromNodeId: 's',
          fromPort: 'pose',
          toNodeId: 'sink',
          toPort: 'inputs',
        },
        {
          fromNodeId: 'trg',
          fromPort: 'trigger',
          toNodeId: 'sink',
          toPort: 'trigger',
        },
      ],
      { s: cfg }
    );
    let t = 1_000_000;
    return (
      pose: NormalizedPose,
      confidence: Record<string, number>,
      dtMs = 100
    ) => {
      cfg.pose = pose;
      cfg.confidence = confidence;
      t += dtMs;
      vi.setSystemTime(t);
      graph.fire('trg', 'trigger', mkEvent(undefined));
      return (graph.peekInput('sink', 'inputs') as NormalizedPose[])[0];
    };
  }
  const pose = (q: Quaternion) => new NormalizedPose([['leftLowerArm', q]]);
  const lowerArm = (p: NormalizedPose) => p.get('leftLowerArm')!;

  it('passes fully confident bones straight through', () => {
    const step = smoother();
    step(pose(I), {});
    expect(angleDeg(lowerArm(step(pose(Q90), {})), Q90)).toBeLessThan(1e-6);
  });

  it('eases an unconfident bone toward its reading instead of jumping', () => {
    const step = smoother();
    step(pose(I), { leftLowerArm: 1 });
    const out = lowerArm(step(pose(Q90), { leftLowerArm: 0 }));
    // maxLag 0.6s at confidence 0, 100ms step → 1 - e^(-1/6) ≈ 15% of the way.
    expect(angleDeg(out, I)).toBeGreaterThan(5);
    expect(angleDeg(out, I)).toBeLessThan(25);
  });

  it('eases back in when confidence recovers instead of snapping', () => {
    const step = smoother();
    step(pose(I), { leftLowerArm: 0 });
    step(pose(I), { leftLowerArm: 0 });
    // Confidence jumps back to 1 together with a big change: the recovery is eased.
    const out = lowerArm(step(pose(Q90), { leftLowerArm: 1 }));
    expect(angleDeg(out, Q90)).toBeGreaterThan(5);
  });

  it('resumes a briefly missing bone from where it was', () => {
    const step = smoother();
    step(pose(I), {});
    step(new NormalizedPose(), {}); // bone missing for one frame
    const out = lowerArm(step(pose(Q90), {}));
    expect(angleDeg(out, Q90)).toBeGreaterThan(5); // resumes at confidence 0, eased
  });

  it('holds back a single-frame jump until it persists (jumpHold)', () => {
    const step = smoother({}); // defaults: hold > 60° for 3 frames
    step(pose(I), {});
    expect(angleDeg(lowerArm(step(pose(Q90), {})), I)).toBeLessThan(1e-6); // held
    expect(angleDeg(lowerArm(step(pose(Q90), {})), I)).toBeLessThan(1e-6); // held
    expect(angleDeg(lowerArm(step(pose(Q90), {})), Q90)).toBeLessThan(1e-6); // accepted
  });

  it('never lets a reading that alternates every frame through (jumpHold)', () => {
    const step = smoother({});
    step(pose(I), {});
    for (let i = 0; i < 6; i++) {
      const out = lowerArm(step(pose(i % 2 ? I : Q90), {}));
      expect(angleDeg(out, I)).toBeLessThan(1e-6);
    }
  });

  it('passes the pose through untouched when disabled', () => {
    const step = smoother({ enabled: false });
    step(pose(I), { leftLowerArm: 1 });
    const out = lowerArm(step(pose(Q90), { leftLowerArm: 0 }));
    expect(angleDeg(out, Q90)).toBeLessThan(1e-6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Technique switches (ArmSolveOptions + pose_smooth), for live A/B comparison
// ─────────────────────────────────────────────────────────────────────────────

describe('arm-solve technique switches', () => {
  it('wires every armSolve.* config field to an existing input port', () => {
    const meta = new Map(getAllNodeKindMeta().map((m) => [m.kind, m]));
    const nodes = new Map(
      MEDIAPIPE_PIPELINE_TEMPLATE.nodes.map((n) => [n.id, n])
    );
    for (const [field, target] of ARM_SOLVE_SWITCHES) {
      const edge = MEDIAPIPE_PIPELINE_TEMPLATE.edges.find(
        (e) => e.fromNodeId === `cfg_arm_${field}`
      );
      expect(edge, field).toBeDefined();
      expect(edge!.toNodeId).toBe(target);
      const kind = nodes.get(target)!.kind;
      const ports = meta.get(kind)!.inputPorts.map((p) => p.name);
      expect(ports, `${kind}.${edge!.toPort}`).toContain(edge!.toPort);
    }
  });

  it('legacy mode brings back the roll-split flips the hinge removed', () => {
    const clip = CLIPS.twist_flip_a;
    const upper = (mode: string) =>
      Math.max(
        ...jumps(runClip(clip, false, { mode }), `${clip.side}UpperArm`)
      );
    expect(upper('hinge')).toBeLessThan(45);
    expect(upper('legacy')).toBeGreaterThan(90);
  });

  it('keepLowVis off drops the forearm when the wrist is not visible', () => {
    const clip = CLIPS.wrist_low_vis;
    const lowVisFrames = clip.frames.filter(
      (f) => (f.pose[16][3] ?? 1) < 0.5
    ).length;
    expect(lowVisFrames).toBeGreaterThan(0);
    const dropped = runClip(clip, false, { keepLowVis: false }).filter(
      (p) => !p.has(`${clip.side}LowerArm` as VRMBoneName)
    ).length;
    expect(dropped).toBe(lowVisFrames);
  });

  it('jump hold and the pose-palm check each cut the forearm jumps of a flicker clip', () => {
    const clip = CLIPS.twist_flip_b;
    const big = (options: Record<string, unknown>) =>
      jumps(runClip(clip, true, options), `${clip.side}Hand`).filter(
        (d) => d > 45
      ).length;
    const neither = big({ jumpHold: false, poseDorsalConf: false });
    expect(big({ jumpHold: true, poseDorsalConf: false })).toBeLessThan(
      neither
    );
    expect(big({ jumpHold: false, poseDorsalConf: true })).toBeLessThan(
      neither
    );
  });
});
