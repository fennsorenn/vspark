import { Blendshapes } from '@vspark/shared/signal'
import type {
  ApiAnimationLoopMode,
  ApiAnimationMessage,
  ApiAnimationQueueEntry,
} from '@vspark/shared'
import { ComponentKind } from '../decorator.js'
import { broadcastBus } from '../../broadcast/bus.js'
import { getDb } from '../../db/index.js'
import type { WSSync } from '../../ws/index.js'

interface ComponentState {
  sceneNodeId: string
  queue:       ApiAnimationQueueEntry[]
  loopMode:    ApiAnimationLoopMode
  startedAt:   number | null
  blendshapes: Blendshapes
}

interface ClipRow {
  id:               string
  name:             string
  source_node_id:   string
  source_file_path: string
  duration:         number
}

const DEFAULT_DURATION_SEC = 5

@ComponentKind({
  kind:          'api_controller',
  label:         'API Controller',
  icon:          '🎛',
  description:   'Drives the avatar via REST: set/queue animations and blendshape expressions.',
  applicableTo:  ['avatar'],
  defaultConfig: {},
})
export class ApiControllerManager {
  private readonly _state         = new Map<string, ComponentState>()
  private readonly _expressionsByNode = new Map<string, string[]>()
  private readonly _ws:    WSSync

  constructor(ws: WSSync) {
    this._ws = ws
  }

  // ── expressions cache (populated by frontend reports over WS) ──────────────

  setExpressionsForNode(nodeId: string, expressions: string[]): void {
    if (expressions.length === 0) this._expressionsByNode.delete(nodeId)
    else this._expressionsByNode.set(nodeId, expressions)
  }

  getExpressionsForNode(nodeId: string): string[] | null {
    return this._expressionsByNode.get(nodeId) ?? null
  }

  // ── component lifecycle ────────────────────────────────────────────────────

  syncComponents(comps: Array<{ id: string; nodeId: string; kind: string; enabled: boolean; config: Record<string, unknown> }>): void {
    const active = new Set<string>()
    for (const c of comps) {
      if (c.kind !== 'api_controller' || !c.enabled) continue
      if (!this._state.has(c.id)) {
        this._state.set(c.id, {
          sceneNodeId: c.nodeId,
          queue:       [],
          loopMode:    'none',
          startedAt:   null,
          blendshapes: new Blendshapes(),
        })
        console.log(`[ApiController] Started component ${c.id}`)
      } else {
        // Hot-update node id in case it ever changes.
        this._state.get(c.id)!.sceneNodeId = c.nodeId
      }
      active.add(c.id)
    }
    for (const id of [...this._state.keys()]) {
      if (!active.has(id)) this._stop(id)
    }
  }

  private _stop(id: string): void {
    this._state.delete(id)
    broadcastBus.removeComponent(id)
    console.log(`[ApiController] Stopped component ${id}`)
  }

  close(): void {
    for (const id of [...this._state.keys()]) this._stop(id)
  }

  // ── lookup ─────────────────────────────────────────────────────────────────

  /** Find the api_controller component on a node, or null. */
  findByNode(nodeId: string): { componentId: string; state: ComponentState } | null {
    for (const [id, st] of this._state) {
      if (st.sceneNodeId === nodeId) return { componentId: id, state: st }
    }
    return null
  }

  getState(componentId: string): ComponentState | null {
    return this._state.get(componentId) ?? null
  }

  /** All active state snapshots — used to rebroadcast on WS reconnect. */
  snapshotAll(): Array<{ componentId: string; state: ComponentState }> {
    return [...this._state.entries()].map(([componentId, state]) => ({ componentId, state }))
  }

  // ── animation ──────────────────────────────────────────────────────────────

  /** Replace the queue, optionally resolving by clip id or name. Throws if a name doesn't resolve. */
  setAnimationQueue(componentId: string, queueInput: Array<{ animation: string }>, loopMode: ApiAnimationLoopMode): void {
    const st = this._state.get(componentId)
    if (!st) throw new Error(`api_controller component ${componentId} not active`)

    const resolved: ApiAnimationQueueEntry[] = queueInput.map((entry) => this._resolveClip(st.sceneNodeId, entry.animation))
    st.queue     = resolved
    st.loopMode  = loopMode
    st.startedAt = resolved.length > 0 ? Date.now() : null

    this._broadcast(componentId, st)
  }

  // ── blendshapes ────────────────────────────────────────────────────────────

  setBlendshapes(componentId: string, weights: Record<string, number>): void {
    const st = this._state.get(componentId)
    if (!st) throw new Error(`api_controller component ${componentId} not active`)
    st.blendshapes = Blendshapes.fromRecord(weights)
    broadcastBus.publishBlendshapes(st.sceneNodeId, componentId, st.blendshapes)
  }

  clearBlendshapes(componentId: string): void {
    const st = this._state.get(componentId)
    if (!st) throw new Error(`api_controller component ${componentId} not active`)
    st.blendshapes = new Blendshapes()
    broadcastBus.publishBlendshapes(st.sceneNodeId, componentId, st.blendshapes)
  }

  // ── reconnect / rebroadcast ────────────────────────────────────────────────

  /** Re-emit current animation queues to a single ws client (called on new connection). */
  rebroadcastTo(send: (kind: string, payload: Record<string, unknown>) => void): void {
    for (const [componentId, st] of this._state) {
      send('api_animation', this._buildMessage(componentId, st) as unknown as Record<string, unknown>)
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private _broadcast(componentId: string, st: ComponentState): void {
    this._ws.broadcast('api_animation', this._buildMessage(componentId, st) as unknown as Record<string, unknown>)
  }

  private _buildMessage(componentId: string, st: ComponentState): ApiAnimationMessage {
    return {
      nodeId:      st.sceneNodeId,
      componentId,
      queue:       st.queue,
      loopMode:    st.loopMode,
      startedAt:   st.startedAt,
    }
  }

  private _resolveClip(sceneNodeId: string, idOrName: string): ApiAnimationQueueEntry {
    const db = getDb()
    // Try id first, scoped to this node so the queue can only reference clips owned by this avatar.
    let row = db.prepare(
      'SELECT id, name, source_node_id, source_file_path, duration FROM animation_clips WHERE id = ? AND source_node_id = ?'
    ).get(idOrName, sceneNodeId) as ClipRow | undefined
    if (!row) {
      row = db.prepare(
        'SELECT id, name, source_node_id, source_file_path, duration FROM animation_clips WHERE name = ? AND source_node_id = ?'
      ).get(idOrName, sceneNodeId) as ClipRow | undefined
    }
    if (!row) throw new Error(`animation clip '${idOrName}' not found for node ${sceneNodeId}`)
    const duration = row.duration > 0 ? row.duration : DEFAULT_DURATION_SEC
    if (!(row.duration > 0)) {
      console.warn(`[ApiController] clip ${row.id} has no duration; defaulting to ${DEFAULT_DURATION_SEC}s`)
    }
    return {
      animationId: row.id,
      sourceUrl:   row.source_file_path,
      duration,
    }
  }
}
