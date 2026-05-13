// Not React state — written by the WS hook, polled by useFrame. No re-renders.
// Keyed by scene nodeId (the VRM entity), not by componentId.
const poses      = new Map<string, Record<string, [number, number, number, number]>>()
const poseTimes  = new Map<string, number>()
const blendshapes = new Map<string, Record<string, number>>()

export function setVmcPose(nodeId: string, bones: Record<string, [number, number, number, number]>) {
  poses.set(nodeId, bones)
  poseTimes.set(nodeId, Date.now())
}
export function getVmcPose(nodeId: string) {
  return poses.get(nodeId)
}
export function getVmcPoseTime(nodeId: string) {
  return poseTimes.get(nodeId) ?? null
}

export function setVmcBlendshapes(nodeId: string, bs: Record<string, number>) {
  blendshapes.set(nodeId, bs)
}
export function getVmcBlendshapes(nodeId: string) {
  return blendshapes.get(nodeId)
}
