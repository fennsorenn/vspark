import type { AnimationBlendMode } from '@vspark/shared';

// Not React state — written by the WS hook, polled by useFrame. No re-renders.
// Keyed by scene nodeId (the VRM entity), not by behaviorId.
const poses = new Map<
  string,
  Record<string, [number, number, number, number]>
>();
const poseTimes = new Map<string, number>();
const poseModes = new Map<string, AnimationBlendMode>();
/** Optional per-bone translation, in fractions of the avatar's hip height. */
const poseOffsets = new Map<string, Record<string, [number, number, number]>>();
const blendshapes = new Map<string, Record<string, number>>();

export function setVmcPose(
  nodeId: string,
  bones: Record<string, [number, number, number, number]>,
  animationBlendMode: AnimationBlendMode = 'override',
  offsets?: Record<string, [number, number, number]>
) {
  poses.set(nodeId, bones);
  poseTimes.set(nodeId, Date.now());
  poseModes.set(nodeId, animationBlendMode);
  // Cleared rather than left stale when a frame carries none, so switching the
  // stylizer off snaps the hips back instead of freezing them displaced.
  if (offsets && Object.keys(offsets).length > 0)
    poseOffsets.set(nodeId, offsets);
  else poseOffsets.delete(nodeId);
}
export function getVmcPose(nodeId: string) {
  return poses.get(nodeId);
}
export function getVmcPoseTime(nodeId: string) {
  return poseTimes.get(nodeId) ?? null;
}
export function getVmcPoseBlendMode(nodeId: string): AnimationBlendMode {
  return poseModes.get(nodeId) ?? 'override';
}

/** The pose's hips translation for this node, in hip-height fractions. */
export function getVmcHipOffset(
  nodeId: string
): [number, number, number] | null {
  return poseOffsets.get(nodeId)?.hips ?? null;
}

export function setVmcBlendshapes(nodeId: string, bs: Record<string, number>) {
  blendshapes.set(nodeId, bs);
}
export function getVmcBlendshapes(nodeId: string) {
  return blendshapes.get(nodeId);
}
