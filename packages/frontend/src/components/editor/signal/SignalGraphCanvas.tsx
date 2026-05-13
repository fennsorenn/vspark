import { useEffect, useMemo, useCallback, useState, useRef } from 'react'
import {
  ReactFlow, Background, Controls, MiniMap,
  useNodesState, useEdgesState,
  type Node, type Edge, type NodeTypes, type EdgeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { SIGNAL_TYPE_COLORS } from '@vspark/shared/signal'
import type {
  GraphDescriptor, NodeKindMeta, NodeStateSnapshot, GraphStateSnapshot,
} from '@vspark/shared/signal'
import { SignalNodeCard } from './SignalNodeCard'
import type { SignalNodeData } from './SignalNodeCard'
import { FlashEdge } from './FlashEdge'
import type { FlashEdgeData } from './FlashEdge'
import { useEditorStore } from '../../../store/editorStore'
import { api, getSignalGraphStates } from '../../../api/client'

// ──────────────────────────────────────────────────────────────────────────────
// Stable type registries (must be outside component to avoid identity changes)
// ──────────────────────────────────────────────────────────────────────────────

const NODE_TYPES: NodeTypes = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signalNode: SignalNodeCard as any,
}

const EDGE_TYPES: EdgeTypes = {
  flashEdge: FlashEdge,
}

// ──────────────────────────────────────────────────────────────────────────────
// Descriptor → React Flow conversion
// ──────────────────────────────────────────────────────────────────────────────

function buildNodes(
  descriptor:  GraphDescriptor,
  kindMap:     Map<string, NodeKindMeta>,
  nodeStates:  Record<string, NodeStateSnapshot>,
  graphId:     string,
): Node<SignalNodeData>[] {
  // Pre-compute which input ports have an incoming edge per node.
  const connectedInputs = new Map<string, Set<string>>()
  for (const e of descriptor.edges) {
    if (!connectedInputs.has(e.toNodeId)) connectedInputs.set(e.toNodeId, new Set())
    connectedInputs.get(e.toNodeId)!.add(e.toPort)
  }

  return descriptor.nodes.map((n) => {
    const meta  = kindMap.get(n.kind)
    const state = nodeStates[n.id]
    return {
      id:       n.id,
      type:     'signalNode',
      position: n.position,
      data: {
        nodeId:        n.id,
        graphId,
        kind:          n.kind,
        display:       meta?.display,
        inputPorts:    meta?.inputPorts  ?? [],
        outputPorts:   meta?.outputPorts ?? [],
        connectedInputPorts: [...(connectedInputs.get(n.id) ?? [])],
        readonly:      descriptor.readonly,
        lastExecutedAt: state?.lastExecutedAt ?? null,
        portValues:    state?.portValues ?? {},
        config:        state?.config ?? null,
      },
    }
  })
}

function buildEdges(
  descriptor:    GraphDescriptor,
  kindMap:       Map<string, NodeKindMeta>,
  flashingEdges: ReadonlySet<string>,
  edgeValues:    Record<string, unknown>,
): Edge<FlashEdgeData>[] {
  return descriptor.edges.map((e) => {
    const srcMeta = kindMap.get(
      descriptor.nodes.find((n) => n.id === e.fromNodeId)?.kind ?? '',
    )
    const srcPort  = srcMeta?.outputPorts.find((p) => p.name === e.fromPort)
    const color    = srcPort
      ? (SIGNAL_TYPE_COLORS[srcPort.type as keyof typeof SIGNAL_TYPE_COLORS] ?? '#555')
      : '#555'
    const isValue  = e.kind === 'value'
    const edgeKey  = `${e.fromNodeId}:${e.fromPort}:${e.toNodeId}:${e.toPort}`
    const rfEdgeId = edgeKey

    return {
      id:           rfEdgeId,
      type:         'flashEdge',
      source:       e.fromNodeId,
      sourceHandle: `out-${e.fromPort}`,
      target:       e.toNodeId,
      targetHandle: `in-${e.toPort}`,
      data: {
        color,
        isValue,
        flashing:  flashingEdges.has(edgeKey),
        lastValue: edgeValues[edgeKey],
        label:     e.fromPort !== e.toPort ? `${e.fromPort} → ${e.toPort}` : undefined,
      } satisfies FlashEdgeData,
    }
  })
}

// ──────────────────────────────────────────────────────────────────────────────
// Canvas
// ──────────────────────────────────────────────────────────────────────────────

interface Props {
  graphId:  string
  kindMeta: NodeKindMeta[]
}

export function SignalGraphCanvas({ graphId, kindMeta }: Props) {
  const { setSelectedSignalNode } = useEditorStore()

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [descriptor, setDescriptor] = useState<GraphDescriptor | null>(null)
  const [nodeStates,  setNodeStates]  = useState<Record<string, NodeStateSnapshot>>({})
  const [flashingEdges, setFlashingEdges] = useState<ReadonlySet<string>>(new Set())
  const [edgeValues, setEdgeValues] = useState<Record<string, unknown>>({})

  // Track previous edge timestamps to detect new firings
  const prevEdgeFiredAt = useRef<Record<string, number | null>>({})
  // Keep timers for clearing individual flashes
  const flashTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const kindMap = useMemo(
    () => new Map(kindMeta.map((m) => [m.kind, m])),
    [kindMeta],
  )

  // Load descriptor once.
  useEffect(() => {
    if (!graphId) return
    let cancelled = false
    api.getSignalGraphs()
      .then((gs) => { if (!cancelled) setDescriptor(gs.find((g) => g.id === graphId) ?? null) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [graphId])

  // Poll graph states at ~500ms for live monitoring.
  useEffect(() => {
    if (!graphId) return
    let cancelled = false

    const poll = async () => {
      let snapshot: GraphStateSnapshot
      try { snapshot = await getSignalGraphStates(graphId) }
      catch { return }
      if (cancelled) return

      setNodeStates(snapshot.nodes)

      // Detect newly-fired edges and schedule flashes.
      const newValues: Record<string, unknown> = {}
      const toFlash: string[] = []

      for (const [key, state] of Object.entries(snapshot.edges)) {
        newValues[key] = state.lastValue
        const prev = prevEdgeFiredAt.current[key]
        if (state.lastFiredAt !== null && state.lastFiredAt !== prev) {
          toFlash.push(key)
          prevEdgeFiredAt.current[key] = state.lastFiredAt
        }
      }

      setEdgeValues(newValues)

      if (toFlash.length > 0) {
        setFlashingEdges((prev) => {
          const next = new Set(prev)
          for (const k of toFlash) {
            next.add(k)
            // Clear any existing timer for this edge
            const existing = flashTimers.current.get(k)
            if (existing) clearTimeout(existing)
            flashTimers.current.set(k, setTimeout(() => {
              setFlashingEdges((s) => { const n = new Set(s); n.delete(k); return n })
              flashTimers.current.delete(k)
            }, 600))
          }
          return next
        })
      }
    }

    poll()
    const iv = setInterval(poll, 500)
    return () => {
      cancelled = true
      clearInterval(iv)
      // eslint-disable-next-line react-hooks/exhaustive-deps
      for (const t of flashTimers.current.values()) clearTimeout(t)
    }
  }, [graphId])

  // Rebuild React Flow nodes whenever descriptor or states change.
  useEffect(() => {
    if (!descriptor) return
    setNodes(buildNodes(descriptor, kindMap, nodeStates, graphId) as Node[])
  }, [descriptor, kindMap, nodeStates, setNodes])

  // Rebuild edges whenever flashing or values change (separate from nodes for perf).
  useEffect(() => {
    if (!descriptor) return
    setEdges(buildEdges(descriptor, kindMap, flashingEdges, edgeValues) as Edge[])
  }, [descriptor, kindMap, flashingEdges, edgeValues, setEdges])

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => setSelectedSignalNode(node.id),
    [setSelectedSignalNode],
  )

  const onPaneClick = useCallback(
    () => setSelectedSignalNode(null),
    [setSelectedSignalNode],
  )

  return (
    <div style={{ width: '100%', height: '100%', background: '#0d0d0d' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.3 }}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background color="#1e1e2e" gap={20} size={1} />
        <Controls
          style={{ background: '#1a1a2a', border: '1px solid #2a2a4a', borderRadius: 6 }}
        />
        <MiniMap
          nodeColor={(n) => ((n.data as SignalNodeData).display?.color ?? '#2a2a4a')}
          maskColor="#0d0d0d99"
          style={{ background: '#111', border: '1px solid #2a2a4a', borderRadius: 6 }}
        />
      </ReactFlow>
    </div>
  )
}
