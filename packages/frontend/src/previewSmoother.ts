import * as THREE from 'three'
import { useEditorStore } from './store/editorStore'
import type { ComposeLayerRecord } from './api/client'

/**
 * Smooths incoming live-preview updates from other clients so they glide
 * between samples instead of snapping. A new preview retargets the tween's
 * `to` and re-baselines `from` to the currently displayed value, so retargeting
 * mid-tween feels seamless.
 *
 * Only used for *received* updates. The sender's own drag/wheel writes go to
 * the store directly — they're authoritative for the local user.
 *
 * Scalar fields use per-field linear tweens. Node rotations are tweened as a
 * single quaternion (slerp) to avoid gimbal-style discontinuities when
 * crossing ±90° on the Y axis (where independent X/Z lerp would flip wildly).
 */

const SMOOTH_MS = 80   // tween window per sample (~2.5 preview intervals at 30 Hz)

type Scope = 'node' | 'layer'

interface ScalarTween {
  scope: Scope
  id: string
  field: string
  from: number
  to: number
  startedAt: number
}

interface QuatTween {
  nodeId: string
  from: THREE.Quaternion
  to: THREE.Quaternion
  startedAt: number
}

const scalarTweens = new Map<string, ScalarTween>()
const quatTweens = new Map<string, QuatTween>()  // keyed by nodeId
let rafHandle: number | null = null

function scalarKey(scope: Scope, id: string, field: string): string {
  return `${scope}:${id}:${field}`
}

function eulerFromTransform(t: Record<string, number> | undefined): THREE.Euler {
  return new THREE.Euler(t?.rx ?? 0, t?.ry ?? 0, t?.rz ?? 0, 'XYZ')
}

function ensureLoop() {
  if (rafHandle != null) return
  const tick = () => {
    rafHandle = null
    const now = performance.now()
    if (scalarTweens.size === 0 && quatTweens.size === 0) return

    // Group field updates per (scope, id).
    const nodePatches = new Map<string, Record<string, number>>()
    const layerPatches = new Map<string, Record<string, number>>()

    // Scalar tweens.
    for (const [k, t] of scalarTweens) {
      const p = Math.min(1, (now - t.startedAt) / SMOOTH_MS)
      const v = t.from + (t.to - t.from) * p
      if (t.scope === 'node') {
        let m = nodePatches.get(t.id); if (!m) { m = {}; nodePatches.set(t.id, m) }
        m[t.field] = v
      } else {
        let m = layerPatches.get(t.id); if (!m) { m = {}; layerPatches.set(t.id, m) }
        m[t.field] = v
      }
      if (p >= 1) scalarTweens.delete(k)
    }

    // Quaternion tweens (node rotation only).
    const quatBuf = new THREE.Quaternion()
    const eulerBuf = new THREE.Euler()
    for (const [nodeId, q] of quatTweens) {
      const p = Math.min(1, (now - q.startedAt) / SMOOTH_MS)
      quatBuf.copy(q.from).slerp(q.to, p)
      eulerBuf.setFromQuaternion(quatBuf, 'XYZ')
      let m = nodePatches.get(nodeId); if (!m) { m = {}; nodePatches.set(nodeId, m) }
      m.rx = eulerBuf.x
      m.ry = eulerBuf.y
      m.rz = eulerBuf.z
      if (p >= 1) quatTweens.delete(nodeId)
    }

    const store = useEditorStore.getState()
    for (const [nodeId, fields] of nodePatches) {
      const node = store.nodes.find((n) => n.id === nodeId)
      if (!node) continue
      const existing = (node.components as Record<string, unknown>).transform as Record<string, unknown> | undefined
      const components = {
        ...node.components,
        transform: { type: 'transform', ...(existing ?? {}), ...fields },
      }
      store.updateNode(nodeId, { components })
    }
    for (const [layerId, fields] of layerPatches) {
      store.updateComposeLayerLocal(layerId, fields as Partial<ComposeLayerRecord>)
    }

    if (scalarTweens.size > 0 || quatTweens.size > 0) rafHandle = requestAnimationFrame(tick)
  }
  rafHandle = requestAnimationFrame(tick)
}

/** Retarget a scalar tween, re-baselining from the current displayed value. */
function retargetScalar(scope: Scope, id: string, field: string, to: number, currentValue: number, isAngleRad = false) {
  let from = currentValue
  if (isAngleRad) {
    // Shortest-arc on a per-axis basis. Only meaningful when we're NOT using
    // a quaternion tween (e.g. layer rotation in degrees has no quaternion path).
    let d = to - from
    while (d > Math.PI)  d -= 2 * Math.PI
    while (d <= -Math.PI) d += 2 * Math.PI
    to = from + d
  }
  scalarTweens.set(scalarKey(scope, id, field), {
    scope, id, field, from, to,
    startedAt: performance.now(),
  })
  ensureLoop()
}

function retargetScalarDeg(scope: Scope, id: string, field: string, to: number, currentValue: number) {
  let from = currentValue
  let d = to - from
  while (d > 180)  d -= 360
  while (d <= -180) d += 360
  to = from + d
  scalarTweens.set(scalarKey(scope, id, field), {
    scope, id, field, from, to,
    startedAt: performance.now(),
  })
  ensureLoop()
}

/** Retarget the node's rotation as a slerp from current → target quaternion. */
function retargetQuat(nodeId: string, currentEuler: THREE.Euler, targetEuler: THREE.Euler) {
  const from = new THREE.Quaternion().setFromEuler(currentEuler)
  const to = new THREE.Quaternion().setFromEuler(targetEuler)
  // Ensure shortest arc (slerp does this when dot < 0; setFromEuler always
  // produces a valid quaternion, so this is just defensive).
  if (from.dot(to) < 0) to.set(-to.x, -to.y, -to.z, -to.w)
  quatTweens.set(nodeId, { nodeId, from, to, startedAt: performance.now() })
  ensureLoop()
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Smooth an incoming node transform preview. Position/scale fields tween per
 *  axis; rotation tweens as a single quaternion to dodge Euler gimbal flips. */
export function smoothNodeTransform(nodeId: string, transform: Record<string, number>) {
  const store = useEditorStore.getState()
  const node = store.nodes.find((n) => n.id === nodeId)
  if (!node) return
  const cur = (node.components as Record<string, unknown>).transform as Record<string, number> | undefined

  // Scalars first (position + scale).
  const scalarFields = ['x', 'y', 'z', 'sx', 'sy', 'sz']
  for (const f of scalarFields) {
    const to = transform[f]
    if (typeof to !== 'number') continue
    retargetScalar('node', nodeId, f, to, cur?.[f] ?? to)
  }

  // Rotation: if any of rx/ry/rz is present, target the full rotation as a
  // quaternion. Missing axes fall back to the current value so partial updates
  // still produce a coherent quaternion target.
  if ('rx' in transform || 'ry' in transform || 'rz' in transform) {
    const target = new THREE.Euler(
      typeof transform.rx === 'number' ? transform.rx : (cur?.rx ?? 0),
      typeof transform.ry === 'number' ? transform.ry : (cur?.ry ?? 0),
      typeof transform.rz === 'number' ? transform.rz : (cur?.rz ?? 0),
      'XYZ',
    )
    // Re-baseline from the currently displayed orientation so retargeting
    // mid-slerp is seamless.
    retargetQuat(nodeId, eulerFromTransform(cur), target)
  }
}

/** Smooth an incoming compose-layer preview patch (x/y/width/height/rotation/etc).
 *  Non-numeric fields are applied immediately without tweening. Layer rotation
 *  is 2D (degrees, single axis) so a scalar shortest-arc tween is enough. */
export function smoothComposeLayer(id: string, patch: Record<string, unknown>) {
  const store = useEditorStore.getState()
  const layer = store.composeLayers.find((l) => l.id === id)
  if (!layer) return

  const linearFields = new Set(['x', 'y', 'width', 'height'])
  const immediate: Partial<ComposeLayerRecord> = {}
  for (const [field, to] of Object.entries(patch)) {
    if (linearFields.has(field) && typeof to === 'number') {
      const from = (layer as unknown as Record<string, number>)[field] ?? to
      retargetScalar('layer', id, field, to, from)
    } else if (field === 'rotation' && typeof to === 'number') {
      retargetScalarDeg('layer', id, field, to, layer.rotation)
    } else {
      (immediate as Record<string, unknown>)[field] = to
    }
  }
  if (Object.keys(immediate).length > 0) {
    store.updateComposeLayerLocal(id, immediate)
  }
}
