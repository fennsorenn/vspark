import { SignalNode, Quaternion, NormalizedPose } from '@vspark/shared/signal';
import type { VRMBoneName } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';

type Landmark = { x: number; y: number; z: number; visibility?: number };
type V3 = [number, number, number];

// MediaPipe Hand 21-point indices.
// https://developers.google.com/mediapipe/solutions/vision/hand_landmarker
const H = {
  wrist: 0,
  thumbCmc: 1,
  thumbMcp: 2,
  thumbIp: 3,
  thumbTip: 4,
  indexMcp: 5,
  indexPip: 6,
  indexDip: 7,
  indexTip: 8,
  middleMcp: 9,
  middlePip: 10,
  middleDip: 11,
  middleTip: 12,
  ringMcp: 13,
  ringPip: 14,
  ringDip: 15,
  ringTip: 16,
  littleMcp: 17,
  littlePip: 18,
  littleDip: 19,
  littleTip: 20,
};

function sub(a: Landmark, b: Landmark): V3 {
  return [a.x - b.x, a.y - b.y, a.z - b.z];
}
function scale(v: V3, s: number): V3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}
function len(v: V3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}
function norm(v: V3): V3 {
  const l = len(v);
  return l < 1e-9 ? [0, 0, 1] : [v[0] / l, v[1] / l, v[2] / l];
}
function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: V3, b: V3): V3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

// Minimal-arc rotation from unit vector `from` to unit vector `to`.
function rotFromTo(from: V3, to: V3): Quaternion {
  const d = dot(from, to);
  if (d > 0.9999) return Quaternion.IDENTITY;
  if (d < -0.9999) {
    const perp: V3 = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const ax = norm(cross(from, perp));
    return new Quaternion(ax[0], ax[1], ax[2], 0);
  }
  const ax = norm(cross(from, to));
  const s = Math.sin(Math.acos(d) / 2);
  return new Quaternion(
    ax[0] * s,
    ax[1] * s,
    ax[2] * s,
    Math.cos(Math.acos(d) / 2)
  );
}

// Rotate vector v by quaternion q.
function qvec(q: Quaternion, v: V3): V3 {
  const ix = q.w * v[0] + q.y * v[2] - q.z * v[1];
  const iy = q.w * v[1] + q.z * v[0] - q.x * v[2];
  const iz = q.w * v[2] + q.x * v[1] - q.y * v[0];
  const iw = -q.x * v[0] - q.y * v[1] - q.z * v[2];
  return [
    ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  ];
}

function qmul(a: Quaternion, b: Quaternion): Quaternion {
  return new Quaternion(
    a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  );
}

function qinv(q: Quaternion): Quaternion {
  return new Quaternion(-q.x, -q.y, -q.z, q.w);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hand coordinate frame
//
// MediaPipe hand landmarks are in image-normalised space:
//   x: 0=left edge, 1=right edge (of bounding box)
//   y: 0=top, 1=bottom (inverted Y vs 3D)
//   z: depth relative to wrist (negative = further from camera)
//
// We build a hand-local 3D frame:
//   fingerAxis  = wrist → middle_mcp (along hand, primary axis)
//   palmNormal  = cross(index_mcp−wrist, pinky_mcp−wrist)
//                 (points out of palm — toward viewer for right hand palm-facing-camera)
//   thumbAxis   = cross(fingerAxis, palmNormal)
//
// In VRM T-pose, for the LEFT hand:
//   The hand bone's +Y axis points from wrist toward middle fingertip.
//   The palm normal in T-pose points in +Z (out of the palm, away from body).
//   The thumb side (+X) points toward the thumb.
//
// For the RIGHT hand it's mirrored: palm normal points -Z, thumb side is -X.
//
// Strategy:
//   1. Build the hand frame from landmarks.
//   2. Express the VRM T-pose hand axes in MediaPipe hand-local coords.
//   3. wristQ = rotation from VRM T-pose hand frame → observed hand frame.
//      This is the normalised-pose local rotation for the hand bone.
//   4. For each finger segment, compute the rotation of the segment direction
//      relative to the parent segment direction, expressed in hand-local space.
//      This gives the local rotation for each finger joint.
// ─────────────────────────────────────────────────────────────────────────────

function buildHandFrame(
  pts: Landmark[],
  side: 'left' | 'right'
): {
  fingerAxis: V3; // wrist → middle_mcp
  palmNormal: V3; // out of palm (toward viewer for right palm-facing-camera)
  thumbAxis: V3; // toward thumb side
  handToWorld: Quaternion; // rotation from VRM T-pose hand frame → MediaPipe image frame
} | null {
  const wrist = pts[H.wrist];
  const iMcp = pts[H.indexMcp];
  const mMcp = pts[H.middleMcp];
  const pMcp = pts[H.littleMcp];

  const fingerAxis = norm(sub(mMcp, wrist));
  // Build palm normal from index and pinky MCP relative to wrist
  const toIndex = sub(iMcp, wrist);
  const toPinky = sub(pMcp, wrist);
  let palmNormal = norm(cross(toIndex, toPinky));

  // For right hand, flip palm normal (mirrored image-space convention)
  if (side === 'right') palmNormal = scale(palmNormal, -1);

  // Ensure palmNormal is perpendicular to fingerAxis
  const projected = scale(fingerAxis, dot(palmNormal, fingerAxis));
  palmNormal = norm([
    palmNormal[0] - projected[0],
    palmNormal[1] - projected[1],
    palmNormal[2] - projected[2],
  ]);

  const thumbAxis = norm(cross(fingerAxis, palmNormal));

  // VRM T-pose hand frame (matches the upper-arm convention):
  //   Left hand:  fingerAxis (wrist→fingers) = +X,  dorsal (back of hand) ≈ +Y, thumb side = -Z
  //   Right hand: fingerAxis = -X,                  dorsal ≈ +Y,                thumb side = -Z
  // We only need two axes to constrain the rotation; we use fingerAxis + dorsal.
  const vrmFingerAxis: V3 = side === 'left' ? [1, 0, 0] : [-1, 0, 0];
  const vrmDorsal: V3 = [0, 1, 0]; // back-of-hand points up at T-pose

  // Step 1: swing VRM fingerAxis → observed fingerAxis
  const swingQ = rotFromTo(vrmFingerAxis, fingerAxis);

  // Step 2: twist around fingerAxis so VRM dorsal maps to observed palmNormal
  const dorsalAfterSwing = qvec(swingQ, vrmDorsal);
  const pa = dot(dorsalAfterSwing, fingerAxis);
  const dorsalProj = norm([
    dorsalAfterSwing[0] - fingerAxis[0] * pa,
    dorsalAfterSwing[1] - fingerAxis[1] * pa,
    dorsalAfterSwing[2] - fingerAxis[2] * pa,
  ]);
  const pb = dot(palmNormal, fingerAxis);
  const nProj = norm([
    palmNormal[0] - fingerAxis[0] * pb,
    palmNormal[1] - fingerAxis[1] * pb,
    palmNormal[2] - fingerAxis[2] * pb,
  ]);

  const twistAngle = Math.atan2(
    dot(cross(dorsalProj, nProj), fingerAxis),
    dot(dorsalProj, nProj)
  );
  const twistQ = new Quaternion(
    fingerAxis[0] * Math.sin(twistAngle / 2),
    fingerAxis[1] * Math.sin(twistAngle / 2),
    fingerAxis[2] * Math.sin(twistAngle / 2),
    Math.cos(twistAngle / 2)
  );
  const handToWorld = qmul(twistQ, swingQ);

  return { fingerAxis, palmNormal, thumbAxis, handToWorld };
}

// For a finger segment from→to, compute the local rotation relative to the
// parent quaternion (accumulated from wrist outward).
//
// VRM finger bones at T-pose rest extend along ±X (same axis as the upper arm).
// The local rotation rotates the rest direction to the observed segment direction
// expressed in the parent's local frame.
function fingerSegmentLocal(
  pts: Landmark[],
  fromIdx: number,
  toIdx: number,
  parentWorldQ: Quaternion,
  restDir: V3
): Quaternion {
  const dir = norm(sub(pts[toIdx], pts[fromIdx]));
  // Express the observed direction in parent-local space.
  const localDir = qvec(qinv(parentWorldQ), dir);
  return rotFromTo(restDir, localDir);
}

function convertHand(pts: Landmark[], side: 'left' | 'right'): NormalizedPose {
  if (pts.length < 21) return new NormalizedPose();

  const frame = buildHandFrame(pts, side);
  if (!frame) return new NormalizedPose();

  const { handToWorld } = frame;
  const entries: [VRMBoneName, Quaternion][] = [];
  const L = side === 'left';
  // Finger bones extend along ±X from the hand at rest (same convention as upper arm).
  const restDir: V3 = L ? [1, 0, 0] : [-1, 0, 0];

  // Hand bone wrist rotation — this is the wrist local rotation in VRM normalised pose
  // (relative to the parent lowerArm bind pose, which in T-pose = identity).
  // We intentionally omit it here because the arm IK sets the hand bone orientation.
  // Only finger joints below the hand bone are set here.

  // Accumulated world rotation for parent tracking (starts from handToWorld)
  // For each finger: MCP is child of hand, PIP child of MCP, DIP child of PIP.
  // Parent of MCP = hand bone = handToWorld.

  const fingers: Array<{
    mcp: number;
    pip: number;
    dip: number;
    tip: number;
    mcpBone: VRMBoneName;
    pipBone: VRMBoneName;
    dipBone: VRMBoneName;
  }> = [
    {
      mcp: H.indexMcp,
      pip: H.indexPip,
      dip: H.indexDip,
      tip: H.indexTip,
      mcpBone: L ? 'leftIndexProximal' : 'rightIndexProximal',
      pipBone: L ? 'leftIndexIntermediate' : 'rightIndexIntermediate',
      dipBone: L ? 'leftIndexDistal' : 'rightIndexDistal',
    },
    {
      mcp: H.middleMcp,
      pip: H.middlePip,
      dip: H.middleDip,
      tip: H.middleTip,
      mcpBone: L ? 'leftMiddleProximal' : 'rightMiddleProximal',
      pipBone: L ? 'leftMiddleIntermediate' : 'rightMiddleIntermediate',
      dipBone: L ? 'leftMiddleDistal' : 'rightMiddleDistal',
    },
    {
      mcp: H.ringMcp,
      pip: H.ringPip,
      dip: H.ringDip,
      tip: H.ringTip,
      mcpBone: L ? 'leftRingProximal' : 'rightRingProximal',
      pipBone: L ? 'leftRingIntermediate' : 'rightRingIntermediate',
      dipBone: L ? 'leftRingDistal' : 'rightRingDistal',
    },
    {
      mcp: H.littleMcp,
      pip: H.littlePip,
      dip: H.littleDip,
      tip: H.littleTip,
      mcpBone: L ? 'leftLittleProximal' : 'rightLittleProximal',
      pipBone: L ? 'leftLittleIntermediate' : 'rightLittleIntermediate',
      dipBone: L ? 'leftLittleDistal' : 'rightLittleDistal',
    },
  ];

  for (const f of fingers) {
    // MCP local (relative to hand = handToWorld)
    const mcpLocal = fingerSegmentLocal(
      pts,
      f.mcp,
      f.pip,
      handToWorld,
      restDir
    );
    entries.push([f.mcpBone, mcpLocal]);

    // PIP local (relative to MCP world = handToWorld * mcpLocal)
    const mcpWorld = qmul(handToWorld, mcpLocal);
    const pipLocal = fingerSegmentLocal(pts, f.pip, f.dip, mcpWorld, restDir);
    entries.push([f.pipBone, pipLocal]);

    // DIP local (relative to PIP world = mcpWorld * pipLocal)
    const pipWorld = qmul(mcpWorld, pipLocal);
    const dipLocal = fingerSegmentLocal(pts, f.dip, f.tip, pipWorld, restDir);
    entries.push([f.dipBone, dipLocal]);
  }

  // Thumb (CMC→MCP→IP→Tip, slightly different chain)
  const thumbCmcLocal = fingerSegmentLocal(
    pts,
    H.thumbCmc,
    H.thumbMcp,
    handToWorld,
    restDir
  );
  entries.push([
    L ? 'leftThumbMetacarpal' : 'rightThumbMetacarpal',
    thumbCmcLocal,
  ]);
  const thumbCmcWorld = qmul(handToWorld, thumbCmcLocal);

  const thumbMcpLocal = fingerSegmentLocal(
    pts,
    H.thumbMcp,
    H.thumbIp,
    thumbCmcWorld,
    restDir
  );
  entries.push([L ? 'leftThumbProximal' : 'rightThumbProximal', thumbMcpLocal]);
  const thumbMcpWorld = qmul(thumbCmcWorld, thumbMcpLocal);

  const thumbIpLocal = fingerSegmentLocal(
    pts,
    H.thumbIp,
    H.thumbTip,
    thumbMcpWorld,
    restDir
  );
  entries.push([L ? 'leftThumbDistal' : 'rightThumbDistal', thumbIpLocal]);

  return new NormalizedPose(entries);
}

@SignalNode({
  label: 'Hand Landmarks → Bones',
  description:
    'Converts MediaPipe 21-point image-space hand landmarks to VRM finger joint quaternions using a hand-local coordinate frame.',
  tags: ['tracking', 'mapping'],
  color: '#4a5a8a',
})
export class HandLandmarksToBones extends Node {
  static readonly kind = 'hand_landmarks_to_bones';

  @valueIn('landmarks', 'LandmarkList') landmarks!: () => Landmark[] | undefined;
  @valueIn('side', 'String') side!: () => string | undefined;

  @valueOut('pose', 'NormalizedPose')
  pose = (): NormalizedPose | undefined => {
    const pts = this.landmarks();
    if (!pts?.length) return undefined;
    const side = this.side() ?? 'left';
    return convertHand(pts, side as 'left' | 'right');
  };
}
