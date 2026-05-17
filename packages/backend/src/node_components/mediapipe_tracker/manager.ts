import { SignalGraph } from '../../signal/engine.js'
import { NODE_REGISTRY } from '../../signal/registry.js'
import { mkEvent } from '@vspark/shared/signal'
import type { GraphDescriptor } from '@vspark/shared/signal'
import { getDb } from '../../db/index.js'
import { ComponentKind } from '../decorator.js'
import { makeMediapipeGraphDescriptor } from './graph.js'
import type { Landmark } from '@vspark/shared'

interface TrackingFrame {
  face?:      Landmark[]
  leftHand?:  Landmark[]
  rightHand?: Landmark[]
  pose?:      Landmark[]
}

@ComponentKind({
  kind:          'mediapipe_tracker',
  label:         'MediaPipe Tracking',
  icon:          '📷',
  description:   'Receives face, hand, and body pose landmarks from the browser camera and drives VRM bones and blendshapes in real time.',
  applicableTo:  ['avatar'],
  defaultConfig: { enableFace: true, enablePose: true, enableHands: true },
})
export class TrackingManager {
  private readonly graphs      = new Map<string, SignalGraph>()
  private readonly descriptors = new Map<string, GraphDescriptor>()
  private readonly nodeStates  = new Map<string, Map<string, unknown>>()
  private readonly nodeIds     = new Map<string, string>()
  private readonly configs     = new Map<string, Record<string, unknown>>()

  private createGraph(componentId: string): SignalGraph {
    const descriptor = makeMediapipeGraphDescriptor(componentId)
    this.descriptors.set(componentId, descriptor)
    if (!this.nodeStates.has(componentId)) this.nodeStates.set(componentId, new Map())

    return SignalGraph.fromDescriptor(
      descriptor,
      NODE_REGISTRY,
      (nodeId) => this._getNodeConfig(componentId, nodeId),
      (nodeId) => this.nodeStates.get(componentId)?.get(nodeId) ?? {},
      (nodeId, state) => {
        this.nodeStates.get(componentId)!.set(nodeId, state)
        this._persistNodeState(componentId, nodeId, state)
      },
    )
  }

  private _getNodeConfig(componentId: string, nodeId: string): unknown {
    const cfg     = this.configs.get(componentId) ?? {}
    const nodeId_ = this.nodeIds.get(componentId) ?? ''
    if (nodeId === 'scene_entity') return { nodeId: nodeId_ }
    if (nodeId === 'comp_id')      return { componentId }

    const descriptor = this.descriptors.get(componentId)
    const nodeDef    = descriptor?.nodes.find(n => n.id === nodeId)
    const defaults   = nodeDef?.defaultConfig ?? {}
    const overrides  = ((cfg.nodeConfig as Record<string, unknown> | undefined)?.[nodeId] ?? {}) as Record<string, unknown>
    return { ...defaults, ...overrides }
  }

  private _persistNodeState(componentId: string, nodeId: string, state: unknown): void {
    try {
      const existing = getDb().prepare('SELECT config FROM node_components WHERE id = ?').get(componentId) as { config: string } | undefined
      if (!existing) return
      const cfg = JSON.parse(existing.config || '{}') as Record<string, unknown>
      const ns  = (cfg._nodeState ?? {}) as Record<string, unknown>
      ns[nodeId] = state
      cfg._nodeState = ns
      getDb().prepare('UPDATE node_components SET config = ? WHERE id = ?').run(JSON.stringify(cfg), componentId)
    } catch { /* non-fatal */ }
  }

  start(componentId: string): void {
    if (this.graphs.has(componentId)) return
    const graph = this.createGraph(componentId)
    this.graphs.set(componentId, graph)
    console.log(`[Tracking] Started component ${componentId}`)
  }

  stop(componentId: string): void {
    if (!this.graphs.has(componentId)) return
    this.graphs.delete(componentId)
    console.log(`[Tracking] Stopped component ${componentId}`)
  }

  syncComponents(comps: Array<{ id: string; nodeId: string; kind: string; enabled: boolean; config: Record<string, unknown> }>): void {
    const active = new Set<string>()
    for (const c of comps) {
      if (c.kind !== 'mediapipe_tracker' || !c.enabled) continue
      const { _nodeState: saved, ...liveConfig } = c.config
      const stateMap = this.nodeStates.get(c.id) ?? new Map<string, unknown>()
      for (const [nid, st] of Object.entries((saved ?? {}) as Record<string, unknown>)) {
        stateMap.set(nid, st)
      }
      this.nodeStates.set(c.id, stateMap)
      this.configs.set(c.id, liveConfig)
      this.nodeIds.set(c.id, c.nodeId)
      this.start(c.id)
      active.add(c.id)
    }
    for (const id of this.graphs.keys()) {
      if (!active.has(id)) this.stop(id)
    }
    for (const c of comps) {
      if (active.has(c.id)) {
        this.configs.set(c.id, c.config)
        this.nodeIds.set(c.id, c.nodeId)
      }
    }
  }

  /** Called by the WS handler for each tracking_input message from the browser. */
  fireLandmarks(componentId: string, frame: TrackingFrame): void {
    const graph = this.graphs.get(componentId)
    if (!graph) return
    const ts = Date.now()
    if (frame.face)      graph.fire('mp_source', 'face',      mkEvent(frame.face,      ts))
    if (frame.leftHand)  graph.fire('mp_source', 'leftHand',  mkEvent(frame.leftHand,  ts))
    if (frame.rightHand) graph.fire('mp_source', 'rightHand', mkEvent(frame.rightHand, ts))
    if (frame.pose)      graph.fire('mp_source', 'pose',      mkEvent(frame.pose,      ts))
  }

  getStates(componentId: string): import('@vspark/shared/signal').GraphStateSnapshot | null {
    return this.graphs.get(componentId)?.getStates() ?? null
  }

  getGraphDescriptor(componentId: string): GraphDescriptor | null {
    return this.descriptors.get(componentId) ?? null
  }

  getAllGraphDescriptors(): GraphDescriptor[] {
    return [...this.descriptors.values()]
  }

  close(): void {
    for (const id of [...this.graphs.keys()]) this.stop(id)
  }
}
