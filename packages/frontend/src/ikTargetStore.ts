// Not React state — written by the WS hook, polled by useFrame. No re-renders.
// Keyed by scene nodeId (the VRM entity).
import type { IkTargetFrame } from '@vspark/shared/types'

const _frames = new Map<string, IkTargetFrame>()
const _times  = new Map<string, number>()

export function setIkTargets(nodeId: string, frame: IkTargetFrame): void {
  _frames.set(nodeId, { ...frame, nodeId })
  _times.set(nodeId, Date.now())
}

export function getIkTargets(nodeId: string): IkTargetFrame | undefined {
  return _frames.get(nodeId)
}

export function getIkTargetsTime(nodeId: string): number | null {
  return _times.get(nodeId) ?? null
}
