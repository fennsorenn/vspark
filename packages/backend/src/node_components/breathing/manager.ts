import { SignalGraph } from '../../signal/engine.js'
import { NODE_REGISTRY } from '../../signal/registry.js'
import { Clock } from '../../signal/nodes/clock.js'
import { makeBreathingGraphDescriptor } from './graph.js'
import { broadcastBus } from '../../broadcast/bus.js'
import type { GraphDescriptor } from '@vspark/shared/signal'
import { getDb } from '../../db/index.js'
import { ComponentKind } from '../decorator.js'

@ComponentKind({
  kind:          'breathing',
  label:         'Breathing',
  icon:          '🫁',
  description:   'Adds procedural breathing motion to the chest and spine bones using a sine oscillator.',
  applicableTo:  ['any'],
  defaultConfig: {},
})
export class BreathingManager {
  private readonly graphs       = new Map<string, SignalGraph>()
  private readonly descriptors  = new Map<string, GraphDescriptor>()
  private readonly nodeStates   = new Map<string, Map<string, unknown>>()
  private readonly componentNodeIds    = new Map<string, string>()
  private readonly componentConfigs    = new Map<string, Record<string, unknown>>()
  private readonly cleanups     = new Map<string, Array<() => void>>()

  // ── graph management ───────────────────────────────────────────────────────

  private createGraph(componentId: string): SignalGraph {
    const descriptor = makeBreathingGraphDescriptor(componentId)
    this.descriptors.set(componentId, descriptor)
    if (!this.nodeStates.has(componentId)) this.nodeStates.set(componentId, new Map())

    const graph = SignalGraph.fromDescriptor(
      descriptor,
      NODE_REGISTRY,
      (nodeId) => this._getNodeConfig(componentId, nodeId),
      (nodeId) => this.nodeStates.get(componentId)?.get(nodeId) ?? {},
      (nodeId, state) => {
        this.nodeStates.get(componentId)!.set(nodeId, state)
        this._persistNodeState(componentId, nodeId, state)
      },
    )

    const fns: Array<() => void> = []

    // Attach clock nodes so they fire on their own timer (tick-driven, independent of tracking).
    for (const nodeDef of descriptor.nodes) {
      if (nodeDef.kind === 'clock') {
        const defaultHz = (nodeDef.defaultConfig?.hz as number | undefined) ?? 30
        fns.push(Clock.attach(
          nodeDef.id,
          defaultHz,
          (gId) => {
            const state = this.nodeStates.get(componentId)?.get(gId) as { hz?: number } | undefined
            return state?.hz ?? defaultHz
          },
          (gId, port, value) => graph.fire(gId, port, value),
        ))
      }
    }

    this.cleanups.set(componentId, fns)
    return graph
  }

  private _getNodeConfig(componentId: string, nodeId: string): unknown {
    const cfg      = this.componentConfigs.get(componentId) ?? {}
    const nodeId_  = this.componentNodeIds.get(componentId) ?? ''

    if (nodeId === 'scene_entity') return { nodeId: nodeId_ }
    if (nodeId === 'comp_id')      return { componentId }

    const descriptor = this.descriptors.get(componentId)
    const nodeDef    = descriptor?.nodes.find(n => n.id === nodeId)
    const defaults   = nodeDef?.defaultConfig ?? {}
    const overrides  = ((cfg.nodeConfig as Record<string, unknown> | undefined)?.[nodeId] ?? {}) as Record<string, unknown>
    // _componentConfig is consumed by `component_config` nodes to resolve dotted
    // field paths against the live component config.
    return { ...defaults, ...overrides, _componentConfig: cfg }
  }

  private _persistNodeState(componentId: string, nodeId: string, state: unknown): void {
    try {
      const existing = getDb().prepare('SELECT config FROM node_components WHERE id = ?').get(componentId) as { config: string } | undefined
      if (!existing) return
      const db  = getDb()
      const cfg = JSON.parse(existing.config || '{}') as Record<string, unknown>
      const ns  = (cfg._nodeState ?? {}) as Record<string, unknown>
      ns[nodeId] = state
      cfg._nodeState = ns
      db.prepare('UPDATE node_components SET config = ? WHERE id = ?').run(JSON.stringify(cfg), componentId)
    } catch { /* non-fatal */ }
  }

  // ── component lifecycle ────────────────────────────────────────────────────

  start(componentId: string): void {
    if (this.graphs.has(componentId)) return
    const graph = this.createGraph(componentId)
    this.graphs.set(componentId, graph)
    console.log(`[Breathing] Started component ${componentId}`)
  }

  stop(componentId: string): void {
    if (!this.graphs.has(componentId)) return
    for (const fn of this.cleanups.get(componentId) ?? []) fn()
    this.cleanups.delete(componentId)
    this.graphs.delete(componentId)
    broadcastBus.removeComponent(componentId)
    console.log(`[Breathing] Stopped component ${componentId}`)
  }

  syncComponents(comps: Array<{ id: string; nodeId: string; kind: string; enabled: boolean; config: Record<string, unknown> }>): void {
    const active = new Set<string>()
    for (const c of comps) {
      if (c.kind !== 'breathing' || !c.enabled) continue
      const { _nodeState: saved, ...liveConfig } = c.config
      // Restore persisted node state.
      const stateMap = this.nodeStates.get(c.id) ?? new Map<string, unknown>()
      for (const [nid, st] of Object.entries((saved ?? {}) as Record<string, unknown>)) {
        stateMap.set(nid, st)
      }
      this.nodeStates.set(c.id, stateMap)
      this.componentConfigs.set(c.id, liveConfig)
      this.componentNodeIds.set(c.id, c.nodeId)
      this.start(c.id)
      active.add(c.id)
    }
    for (const id of this.graphs.keys()) {
      if (!active.has(id)) this.stop(id)
    }
    // Hot-apply config updates.
    for (const c of comps) {
      if (active.has(c.id)) {
        this.componentConfigs.set(c.id, c.config)
        this.componentNodeIds.set(c.id, c.nodeId)
      }
    }
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
