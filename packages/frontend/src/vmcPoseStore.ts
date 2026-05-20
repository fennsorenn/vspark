import type { AnimationBlendMode } from '@vspark/shared'

// Not React state — written by the WS hook, polled by useFrame. No re-renders.
// Keyed by scene nodeId (the VRM entity), not by componentId.
const poses      = new Map<string, Record<string, [number, number, number, number]>>()
const poseTimes  = new Map<string, number>()
const poseModes  = new Map<string, AnimationBlendMode>()
const blendshapes = new Map<string, Record<string, number>>()

export function setVmcPose(
  nodeId:             string,
  bones:              Record<string, [number, number, number, number]>,
  animationBlendMode: AnimationBlendMode = 'override',
) {
  poses.set(nodeId, bones)
  poseTimes.set(nodeId, Date.now())
  poseModes.set(nodeId, animationBlendMode)
}
export function getVmcPose(nodeId: string) {
  return poses.get(nodeId)
}
export function getVmcPoseTime(nodeId: string) {
  return poseTimes.get(nodeId) ?? null
}
export function getVmcPoseBlendMode(nodeId: string): AnimationBlendMode {
  return poseModes.get(nodeId) ?? 'override'
}

export function setVmcBlendshapes(nodeId: string, bs: Record<string, number>) {
  blendshapes.set(nodeId, bs)
}
export function getVmcBlendshapes(nodeId: string) {
  return blendshapes.get(nodeId)
}
