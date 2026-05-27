import { useEffect, useMemo, useCallback, useState, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { SIGNAL_TYPE_COLORS } from '@vspark/shared/signal';
import type {
  GraphDescriptor,
  NodeKindMeta,
  NodeStateSnapshot,
  GraphStateSnapshot,
  GraphNodeDescriptor,
  GraphEdgeDescriptor,
} from '@vspark/shared/signal';
import { SignalNodeCard } from './SignalNodeCard';
import type { SignalNodeData } from './SignalNodeCard';
import { FlashEdge } from './FlashEdge';
import type { FlashEdgeData } from './FlashEdge';
import { useEditorStore } from '../../../store/editorStore';
import { api, getSignalGraphStates } from '../../../api/client';
import { useParams } from 'react-router-dom';

// ──────────────────────────────────────────────────────────────────────────────
// Stable type registries (must be outside component to avoid identity changes)
// ──────────────────────────────────────────────────────────────────────────────

const NODE_TYPES: NodeTypes = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signalNode: SignalNodeCard as any,
};

const EDGE_TYPES: EdgeTypes = {
  flashEdge: FlashEdge,
};

/** MIME-ish key used by the NodePalette drag-source → canvas drop-target wiring. */
export const PALETTE_DRAG_KIND = 'application/x-vspark-signal-node-kind';

// ──────────────────────────────────────────────────────────────────────────────
// Descriptor → React Flow conversion
// ──────────────────────────────────────────────────────────────────────────────

function buildNodes(
  descriptor: GraphDescriptor,
  kindMap: Map<string, NodeKindMeta>,
  nodeStates: Record<string, NodeStateSnapshot>,
  graphId: string
): Node<SignalNodeData>[] {
  // Pre-compute which input ports have an incoming edge per node.
  const connectedInputs = new Map<string, Set<string>>();
  for (const e of descriptor.edges) {
    if (!connectedInputs.has(e.toNodeId))
      connectedInputs.set(e.toNodeId, new Set());
    connectedInputs.get(e.toNodeId)!.add(e.toPort);
  }

  return descriptor.nodes.map((n) => {
    const meta = kindMap.get(n.kind);
    const state = nodeStates[n.id];
    return {
      id: n.id,
      type: 'signalNode',
      position: n.position,
      data: {
        nodeId: n.id,
        graphId,
        kind: n.kind,
        display: meta?.display,
        inputPorts: meta?.inputPorts ?? [],
        outputPorts: meta?.outputPorts ?? [],
        connectedInputPorts: [...(connectedInputs.get(n.id) ?? [])],
        readonly: descriptor.readonly,
        lastExecutedAt: state?.lastExecutedAt ?? null,
        portValues: state?.portValues ?? {},
        config: state?.config ?? n.defaultConfig ?? null,
      },
    };
  });
}

function buildEdges(
  descriptor: GraphDescriptor,
  kindMap: Map<string, NodeKindMeta>,
  flashingEdges: ReadonlySet<string>,
  edgeValues: Record<string, unknown>
): Edge<FlashEdgeData>[] {
  return descriptor.edges.map((e) => {
    const srcMeta = kindMap.get(
      descriptor.nodes.find((n) => n.id === e.fromNodeId)?.kind ?? ''
    );
    const srcPort = srcMeta?.outputPorts.find((p) => p.name === e.fromPort);
    const color = srcPort
      ? SIGNAL_TYPE_COLORS[srcPort.type as keyof typeof SIGNAL_TYPE_COLORS]
      : '#888';
    const isValue = srcPort?.portKind !== 'event';
    const edgeKey = `${e.fromNodeId}:${e.fromPort}:${e.toNodeId}:${e.toPort}`;
    return {
      id: edgeKey,
      source: e.fromNodeId,
      sourceHandle: `out-${e.fromPort}`,
      target: e.toNodeId,
      targetHandle: `in-${e.toPort}`,
      type: 'flashEdge',
      data: {
        color,
        isValue,
        flashing: flashingEdges.has(edgeKey),
        lastValue: edgeValues[edgeKey],
        label:
          e.fromPort !== e.toPort ? `${e.fromPort} → ${e.toPort}` : undefined,
      } satisfies FlashEdgeData,
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Canvas
// ──────────────────────────────────────────────────────────────────────────────

interface Props {
  graphId: string;
  kindMeta: NodeKindMeta[];
}

export function SignalGraphCanvas(props: Props) {
  // React Flow's screenToFlowPosition needs to run inside the provider.
  return (
    <ReactFlowProvider>
      <SignalGraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function SignalGraphCanvasInner({ graphId, kindMeta }: Props) {
  const setSelectedSignalNode = useEditorStore((s) => s.setSelectedSignalNode);
  const setActiveGraphWritable = useEditorStore(
    (s) => s.setActiveGraphWritable
  );
  const { screenToFlowPosition } = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [descriptor, setDescriptor] = useState<GraphDescriptor | null>(null);
  const [nodeStates, setNodeStates] = useState<
    Record<string, NodeStateSnapshot>
  >({});
  const [flashingEdges, setFlashingEdges] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [edgeValues, setEdgeValues] = useState<Record<string, unknown>>({});
  // Local mirror of writable so JSX re-renders when the descriptor source resolves.
  const [writable, setWritable] = useState(false);

  // For writable project graphs we keep our own mutable copy of the descriptor
  // and PUT it back debounced. `descriptor` above is the rendered baseline.
  const editableRef = useRef<GraphDescriptor | null>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writableRef = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Track previous edge timestamps to detect new firings
  const prevEdgeFiredAt = useRef<Record<string, number | null>>({});
  // Keep timers for clearing individual flashes
  const flashTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );

  const kindMap = useMemo(
    () => new Map(kindMeta.map((m) => [m.kind, m])),
    [kindMeta]
  );

  const { projectId } = useParams<{ projectId: string }>();

  // Load descriptor — first check component-owned graphs (read-only), then
  // fall back to standalone project graphs (writable).
  useEffect(() => {
    if (!graphId) return;
    let cancelled = false;
    (async () => {
      try {
        const componentGraphs = await api.getSignalGraphs();
        const match = componentGraphs.find((g) => g.id === graphId);
        if (match) {
          if (!cancelled) {
            writableRef.current = false;
            setWritable(false);
            setActiveGraphWritable(false);
            setDescriptor(match);
          }
          return;
        }
      } catch {
        /* ignore */
      }
      if (!projectId) return;
      try {
        const projectGraphs = await api.getProjectGraphs(projectId);
        const pg = projectGraphs.find((g) => g.id === graphId);
        if (pg && !cancelled) {
          const d: GraphDescriptor = {
            ...pg.descriptor,
            id: pg.id,
            label: pg.name,
            readonly: false,
          };
          writableRef.current = true;
          editableRef.current = d;
          setWritable(true);
          setActiveGraphWritable(true);
          setDescriptor(d);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [graphId, projectId, setActiveGraphWritable]);

  // Clear writable flag on unmount (so leaving the graph view also clears).
  useEffect(
    () => () => {
      setActiveGraphWritable(false);
    },
    [setActiveGraphWritable]
  );

  // Poll graph states at ~500ms for live monitoring.
  useEffect(() => {
    if (!graphId) return;
    let cancelled = false;

    const poll = async () => {
      let snapshot: GraphStateSnapshot;
      try {
        snapshot = await getSignalGraphStates(graphId);
      } catch {
        return;
      }
      if (cancelled) return;

      setNodeStates(snapshot.nodes);

      const newValues: Record<string, unknown> = {};
      const toFlash: string[] = [];

      for (const [key, state] of Object.entries(snapshot.edges)) {
        newValues[key] = state.lastValue;
        const prev = prevEdgeFiredAt.current[key];
        if (state.lastFiredAt !== null && state.lastFiredAt !== prev) {
          toFlash.push(key);
          prevEdgeFiredAt.current[key] = state.lastFiredAt;
        }
      }

      setEdgeValues(newValues);

      if (toFlash.length > 0) {
        setFlashingEdges((prev) => {
          const next = new Set(prev);
          for (const k of toFlash) {
            next.add(k);
            const existing = flashTimers.current.get(k);
            if (existing) clearTimeout(existing);
            flashTimers.current.set(
              k,
              setTimeout(() => {
                setFlashingEdges((s) => {
                  const n = new Set(s);
                  n.delete(k);
                  return n;
                });
                flashTimers.current.delete(k);
              }, 600)
            );
          }
          return next;
        });
      }
    };

    poll();
    const iv = setInterval(poll, 500);
    return () => {
      cancelled = true;
      clearInterval(iv);
      // eslint-disable-next-line react-hooks/exhaustive-deps
      for (const t of flashTimers.current.values()) clearTimeout(t);
    };
  }, [graphId]);

  // Rebuild React Flow nodes whenever descriptor or states change.
  useEffect(() => {
    if (!descriptor) return;
    setNodes(buildNodes(descriptor, kindMap, nodeStates, graphId) as Node[]);
  }, [descriptor, kindMap, nodeStates, setNodes, graphId]);

  // Rebuild edges whenever flashing or values change (separate from nodes for perf).
  useEffect(() => {
    if (!descriptor) return;
    setEdges(
      buildEdges(descriptor, kindMap, flashingEdges, edgeValues) as Edge[]
    );
  }, [descriptor, kindMap, flashingEdges, edgeValues, setEdges]);

  // ── persistence ─────────────────────────────────────────────────────────

  /** Replace the in-memory descriptor and schedule a debounced PUT. */
  const mutateDescriptor = useCallback(
    (mut: (d: GraphDescriptor) => GraphDescriptor) => {
      if (!writableRef.current) return;
      const current = editableRef.current;
      if (!current) return;
      const next = mut(current);
      editableRef.current = next;
      setDescriptor(next);
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        // Strip the wrapper fields the backend doesn't store on the row.
        void api
          .updateProjectGraph(graphId, {
            descriptor: {
              id: next.id,
              label: next.label,
              readonly: false,
              nodes: next.nodes,
              edges: next.edges,
            },
          })
          .catch((e) => {
            console.error('[SignalGraphCanvas] persist failed:', e);
          });
      }, 400);
    },
    [graphId]
  );

  // Flush pending PUT on unmount so a quick edit-then-leave doesn't lose data.
  useEffect(() => {
    return () => {
      if (!persistTimer.current) return;
      clearTimeout(persistTimer.current);
      persistTimer.current = null;
      const next = editableRef.current;
      if (writableRef.current && next) {
        void api
          .updateProjectGraph(graphId, {
            descriptor: {
              id: next.id,
              label: next.label,
              readonly: false,
              nodes: next.nodes,
              edges: next.edges,
            },
          })
          .catch(() => {});
      }
    };
  }, [graphId]);

  // ── React Flow event handlers ───────────────────────────────────────────

  /**
   * onNodesChange handles selection + dragging in-place. For drags we let
   * React Flow update the visual node first, then mirror the new position
   * into the descriptor on dragend (the 'position' change with dragging=false).
   */
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);
      if (!writableRef.current) return;
      const positionEnds = changes.filter(
        (c) => c.type === 'position' && c.dragging === false && c.position
      ) as Array<
        NodeChange & { id: string; position: { x: number; y: number } }
      >;
      const removals = changes.filter((c) => c.type === 'remove') as Array<
        NodeChange & { id: string }
      >;
      if (positionEnds.length === 0 && removals.length === 0) return;
      mutateDescriptor((d) => {
        let nodes = d.nodes;
        let edges = d.edges;
        if (positionEnds.length > 0) {
          const byId = new Map(positionEnds.map((c) => [c.id, c.position]));
          nodes = nodes.map((n) =>
            byId.has(n.id) ? { ...n, position: byId.get(n.id)! } : n
          );
        }
        if (removals.length > 0) {
          const removeIds = new Set(removals.map((c) => c.id));
          nodes = nodes.filter((n) => !removeIds.has(n.id));
          edges = edges.filter(
            (e) => !removeIds.has(e.fromNodeId) && !removeIds.has(e.toNodeId)
          );
        }
        return { ...d, nodes, edges };
      });
    },
    [onNodesChange, mutateDescriptor]
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChange(changes);
      if (!writableRef.current) return;
      const removals = changes.filter((c) => c.type === 'remove') as Array<
        EdgeChange & { id: string }
      >;
      if (removals.length === 0) return;
      const removeIds = new Set(removals.map((c) => c.id));
      mutateDescriptor((d) => ({
        ...d,
        edges: d.edges.filter(
          (e) =>
            !removeIds.has(
              `${e.fromNodeId}:${e.fromPort}:${e.toNodeId}:${e.toPort}`
            )
        ),
      }));
    },
    [onEdgesChange, mutateDescriptor]
  );

  const handleConnect = useCallback(
    (conn: Connection) => {
      if (!writableRef.current) return;
      if (
        !conn.source ||
        !conn.target ||
        !conn.sourceHandle ||
        !conn.targetHandle
      )
        return;
      // sourceHandle looks like "out-portName", targetHandle "in-portName".
      const fromPort = conn.sourceHandle.replace(/^out-/, '');
      const toPort = conn.targetHandle.replace(/^in-/, '');
      mutateDescriptor((d) => {
        // De-dup — value/list ports shouldn't be wired twice from the same source.
        const key = `${conn.source}:${fromPort}:${conn.target}:${toPort}`;
        if (
          d.edges.some(
            (e) =>
              `${e.fromNodeId}:${e.fromPort}:${e.toNodeId}:${e.toPort}` === key
          )
        )
          return d;
        // Infer kind from the source port's portKind via the kindMap.
        const srcNode = d.nodes.find((n) => n.id === conn.source);
        const srcMeta = srcNode ? kindMap.get(srcNode.kind) : undefined;
        const srcPort = srcMeta?.outputPorts.find((p) => p.name === fromPort);
        const srcKind = narrowPortKind(srcPort?.portKind);
        const dstNode = d.nodes.find((n) => n.id === conn.target);
        const dstMeta = dstNode ? kindMap.get(dstNode.kind) : undefined;
        const dstPort = dstMeta?.inputPorts.find((p) => p.name === toPort);
        const edgeKind: GraphEdgeDescriptor['kind'] =
          dstPort?.portKind === 'list' ? 'list' : srcKind;
        return {
          ...d,
          edges: [
            ...d.edges,
            {
              fromNodeId: conn.source!,
              fromPort,
              toNodeId: conn.target!,
              toPort,
              kind: edgeKind,
            },
          ],
        };
      });
    },
    [mutateDescriptor, kindMap]
  );

  /**
   * Inline-literal edits from SignalNodeCard arrive here via a window-level
   * custom event because the card is rendered by React Flow and can't easily
   * receive a fresh closure without a re-render storm. The mutateDescriptor
   * call already short-circuits when the graph isn't writable, so attaching
   * unconditionally is safe.
   */
  useEffect(() => {
    const onLiteralChange = (e: Event) => {
      const ce = e as CustomEvent<{
        graphId: string;
        nodeId: string;
        portName: string;
        value: unknown;
      }>;
      const d = ce.detail;
      if (!d || d.graphId !== graphId) return;
      mutateDescriptor((g) => ({
        ...g,
        nodes: g.nodes.map((n) =>
          n.id === d.nodeId
            ? {
                ...n,
                defaultConfig: {
                  ...(n.defaultConfig ?? {}),
                  [d.portName]: d.value,
                },
              }
            : n
        ),
      }));
    };
    window.addEventListener(
      'vspark:project-graph-literal',
      onLiteralChange as EventListener
    );
    return () =>
      window.removeEventListener(
        'vspark:project-graph-literal',
        onLiteralChange as EventListener
      );
  }, [graphId, mutateDescriptor]);

  // ── Drop from palette ──────────────────────────────────────────────────

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!writableRef.current) return;
    if (e.dataTransfer.types.includes(PALETTE_DRAG_KIND)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!writableRef.current) return;
      const kind = e.dataTransfer.getData(PALETTE_DRAG_KIND);
      if (!kind) return;
      e.preventDefault();
      const meta = kindMap.get(kind);
      if (!meta) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const id = `${kind}_${cryptoRandom()}`;
      const newNode: GraphNodeDescriptor = {
        id,
        kind,
        position,
        defaultConfig: {},
      };
      mutateDescriptor((d) => ({ ...d, nodes: [...d.nodes, newNode] }));
    },
    [kindMap, mutateDescriptor, screenToFlowPosition]
  );

  // ── selection ──────────────────────────────────────────────────────────

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => setSelectedSignalNode(node.id),
    [setSelectedSignalNode]
  );

  const onPaneClick = useCallback(
    () => setSelectedSignalNode(null),
    [setSelectedSignalNode]
  );

  // Suppress noisy React Flow change-application when the graph is read-only,
  // so accidental keypresses or drags don't update visual state we can't persist.
  const handleReadonlyNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Keep selection toggles, drop everything else (drag, remove, etc.).
      const allowed = changes.filter((c) => c.type === 'select');
      if (allowed.length > 0) setNodes((ns) => applyNodeChanges(allowed, ns));
    },
    [setNodes]
  );

  return (
    <div
      ref={wrapperRef}
      style={{ width: '100%', height: '100%', background: '#0d0d0d' }}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={writable ? handleNodesChange : handleReadonlyNodesChange}
        onEdgesChange={writable ? handleEdgesChange : undefined}
        onConnect={writable ? handleConnect : undefined}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodesDraggable={writable}
        nodesConnectable={writable}
        edgesReconnectable={writable}
        elementsSelectable
        deleteKeyCode={writable ? ['Backspace', 'Delete'] : null}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background color="#1e1e2e" gap={20} size={1} />
        <Controls
          style={{
            background: '#1a1a2a',
            border: '1px solid #2a2a4a',
            borderRadius: 6,
          }}
        />
        <MiniMap
          nodeColor={(n) =>
            (n.data as SignalNodeData).display?.color ?? '#2a2a4a'
          }
          maskColor="#0d0d0d99"
          style={{
            background: '#111',
            border: '1px solid #2a2a4a',
            borderRadius: 6,
          }}
        />
      </ReactFlow>
    </div>
  );
}

function cryptoRandom(): string {
  try {
    return globalThis.crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

function narrowPortKind(k: string | undefined): GraphEdgeDescriptor['kind'] {
  return k === 'value' || k === 'list' ? k : 'event';
}
