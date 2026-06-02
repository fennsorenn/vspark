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
  NodePortMeta,
  NodeStateSnapshot,
  GraphStateSnapshot,
  GraphNodeDescriptor,
  GraphEdgeDescriptor,
} from '@vspark/shared/signal';
import { InferGraph } from '@vspark/shared/inference';
import { inferForKind } from '@vspark/shared/infer_nodes';
import { transportOf, type ResolvedPort } from '@vspark/shared/signal_types';
import type { PortMeta } from '@vspark/shared/node';
import { SignalNodeCard } from './SignalNodeCard';
import type { SignalNodeData } from './SignalNodeCard';
import { FlashEdge } from './FlashEdge';
import type { FlashEdgeData } from './FlashEdge';
import { useEditorStore } from '../../../store/editorStore';
import { api, getSignalGraphStates } from '../../../api/client';
import { copyToClipboard, pasteFromClipboard } from '../../../clipboard';

/** Mint a short, unique-enough node id for pasted nodes. Graph descriptor
 *  node ids are arbitrary strings (not constrained to UUIDs); using a
 *  short random keeps the canvas readable when inspecting via dev tools. */
function randomNodeId(): string {
  return `n_${Math.random().toString(36).slice(2, 10)}`;
}

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

/** Reconstruct a kind's static PortMeta list from its served NodeKindMeta. */
function staticPortsOf(meta: NodeKindMeta | undefined): PortMeta[] {
  if (!meta) return [];
  const mk = (p: NodePortMeta, direction: 'in' | 'out'): PortMeta => ({
    name: p.name,
    direction,
    transport: p.transport,
    typeTag: p.typeTag,
    member: p.name,
  });
  return [
    ...meta.inputPorts.map((p) => mk(p, 'in')),
    ...meta.outputPorts.map((p) => mk(p, 'out')),
  ];
}

/**
 * Build an inference mirror of the descriptor so the editor can render resolved
 * (dynamic) ports and validate drags with the SAME shared logic the backend engine
 * uses. Edges that fail validation are skipped (mirrors the backend's load behaviour).
 */
function buildMirror(
  descriptor: GraphDescriptor,
  kindMap: Map<string, NodeKindMeta>
): InferGraph {
  const g = new InferGraph(inferForKind, (kind) =>
    staticPortsOf(kindMap.get(kind))
  );
  for (const n of descriptor.nodes) g.addNode(n.id, n.kind, n.defaultConfig ?? {});
  for (const e of descriptor.edges)
    g.tryAddEdge({
      fromNodeId: e.fromNodeId,
      fromPort: e.fromPort,
      toNodeId: e.toNodeId,
      toPort: e.toPort,
    });
  return g;
}

/** Convert a resolved port into the NodePortMeta shape the card renders. */
function resolvedToPortMeta(p: ResolvedPort): NodePortMeta {
  const transport = transportOf(p.type);
  // Leaf tag for colour: primitive name, or 'Any' for unknown/records/events.
  let typeTag: NodePortMeta['typeTag'] = 'Any';
  let t = p.type;
  if (t.kind === 'event') t = t.payload;
  if (t.kind === 'list') t = t.element;
  if (t.kind === 'primitive') typeTag = t.name;
  return { name: p.name, resolved: p.type, typeTag, transport };
}

function buildNodes(
  descriptor: GraphDescriptor,
  kindMap: Map<string, NodeKindMeta>,
  mirror: InferGraph,
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
    // Resolved (dynamic) ports from the inference mirror — so pack_event grows
    // named-field slots and unpack_event grows one output per record field live.
    const resolved = mirror.portsOf(n.id);
    return {
      id: n.id,
      type: 'signalNode',
      position: n.position,
      data: {
        nodeId: n.id,
        graphId,
        kind: n.kind,
        display: meta?.display,
        inputPorts: resolved.inputPorts.map(resolvedToPortMeta),
        outputPorts: resolved.outputPorts.map(resolvedToPortMeta),
        connectedInputPorts: [...(connectedInputs.get(n.id) ?? [])],
        readonly: descriptor.readonly,
        lastExecutedAt: state?.lastExecutedAt ?? null,
        portValues: state?.portValues ?? {},
        config: state?.config ?? n.defaultConfig ?? null,
      },
    };
  });
}

/** Merge a freshly-built node list into the existing React Flow node list,
 *  preserving the prior node object (and therefore React Flow's internal
 *  `selected` / `dragging` / measured `width|height` flags) when no
 *  user-visible field changed. New ids append at the end of `prev`'s order
 *  for stability; removed ids drop out. */
function mergeNodes<T extends Node>(prev: T[], next: T[]): T[] {
  const nextById = new Map(next.map((n) => [n.id, n] as const));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const p of prev) {
    const n = nextById.get(p.id);
    if (!n) continue; // removed
    seen.add(p.id);
    // Reuse the prior object unless data / position / type changed.
    const dataSame = shallowEqual(
      p.data as Record<string, unknown>,
      n.data as Record<string, unknown>
    );
    const posSame =
      p.position?.x === n.position?.x && p.position?.y === n.position?.y;
    if (dataSame && posSame && p.type === n.type) {
      out.push(p);
    } else {
      // Preserve selected/dragging by spreading prev first, then overwriting
      // the changed fields.
      out.push({
        ...p,
        ...n,
        // selected lives on the React Flow side; explicitly carry it.
        selected: p.selected,
      } as T);
    }
  }
  for (const n of next) {
    if (!seen.has(n.id)) out.push(n);
  }
  return out;
}

/** Edge counterpart of mergeNodes. Same selection-preservation goal. */
function mergeEdges<T extends Edge>(prev: T[], next: T[]): T[] {
  const nextById = new Map(next.map((e) => [e.id, e] as const));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const p of prev) {
    const n = nextById.get(p.id);
    if (!n) continue;
    seen.add(p.id);
    const dataSame = shallowEqual(
      p.data as Record<string, unknown>,
      n.data as Record<string, unknown>
    );
    if (
      dataSame &&
      p.source === n.source &&
      p.target === n.target &&
      p.sourceHandle === n.sourceHandle &&
      p.targetHandle === n.targetHandle &&
      p.type === n.type
    ) {
      out.push(p);
    } else {
      out.push({ ...p, ...n, selected: p.selected } as T);
    }
  }
  for (const e of next) {
    if (!seen.has(e.id)) out.push(e);
  }
  return out;
}

/** Single-level value compare. Good enough for the data objects in
 *  buildNodes/buildEdges, which are flat records of scalars + small arrays. */
function shallowEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const av = a[k];
    const bv = b[k];
    if (av === bv) continue;
    // Arrays of scalars and tiny objects: compare via JSON. Worst-case the
    // node carries portValues (could be big); accept the cost — these are
    // single-graph rates, not per-frame.
    if (typeof av === 'object' || typeof bv === 'object') {
      if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
    } else {
      return false;
    }
  }
  return true;
}

function buildEdges(
  descriptor: GraphDescriptor,
  mirror: InferGraph,
  flashingEdges: ReadonlySet<string>,
  edgeValues: Record<string, unknown>
): Edge<FlashEdgeData>[] {
  return descriptor.edges.map((e) => {
    const srcType = mirror.outputType(e.fromNodeId, e.fromPort);
    const srcPort = srcType ? resolvedToPortMeta({ name: e.fromPort, type: srcType }) : undefined;
    const color = srcPort
      ? SIGNAL_TYPE_COLORS[srcPort.typeTag as keyof typeof SIGNAL_TYPE_COLORS]
      : '#888';
    const isValue = srcPort?.transport !== 'event';
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
  // Transient banner shown when a drag connection is refused by type inference.
  const [rejectMsg, setRejectMsg] = useState<string | null>(null);

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

  // Inference mirror — rebuilt whenever the descriptor changes. Drives dynamic
  // port rendering (buildNodes/buildEdges) and drag-time validation (handleConnect),
  // using the same shared inference the backend engine runs.
  const mirror = useMemo(
    () => (descriptor ? buildMirror(descriptor, kindMap) : null),
    [descriptor, kindMap]
  );

  // Show + auto-dismiss the connection-rejected banner (fired by handleConnect).
  useEffect(() => {
    const onReject = (e: Event) => {
      const reason = (e as CustomEvent<{ reason: string }>).detail?.reason;
      if (reason) setRejectMsg(reason);
    };
    window.addEventListener('vspark:graph-connect-rejected', onReject);
    return () =>
      window.removeEventListener('vspark:graph-connect-rejected', onReject);
  }, []);
  useEffect(() => {
    if (!rejectMsg) return;
    const t = setTimeout(() => setRejectMsg(null), 3500);
    return () => clearTimeout(t);
  }, [rejectMsg]);


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
      // Fall back to standalone graphs (project / scene_node / compose_layer)
      // via the generic getGraph endpoint. All three owner kinds are writable
      // via the same PUT /graphs/:id route.
      try {
        const g = await api.getGraph(graphId);
        if (g && !cancelled) {
          const d: GraphDescriptor = {
            ...g.descriptor,
            id: g.id,
            label: g.name,
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
  }, [graphId, setActiveGraphWritable]);

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
  //
  // Naïve setNodes(buildNodes(...)) here clobbers React Flow's internal
  // per-node `selected` / `dragging` flags every time the 500ms poll
  // updates nodeStates — selecting a noodle then mousing away would clear
  // the selection on the next tick. Instead merge by id: keep the existing
  // node object (preserving selected/etc.) and only replace `data` /
  // `position` when those actually changed.
  useEffect(() => {
    if (!descriptor || !mirror) return;
    setNodes((prev) =>
      mergeNodes(
        prev,
        buildNodes(descriptor, kindMap, mirror, nodeStates, graphId) as Node[]
      )
    );
  }, [descriptor, kindMap, mirror, nodeStates, setNodes, graphId]);

  // Rebuild edges whenever flashing or values change (separate from nodes for perf).
  // Same selection-preservation rationale as nodes above: merge by id rather
  // than rebuild, so React Flow's per-edge selected flag survives the poll.
  useEffect(() => {
    if (!descriptor || !mirror) return;
    setEdges((prev) =>
      mergeEdges(
        prev,
        buildEdges(descriptor, mirror, flashingEdges, edgeValues) as Edge[]
      )
    );
  }, [descriptor, mirror, flashingEdges, edgeValues, setEdges]);

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
          .updateGraph(graphId, {
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
          .updateGraph(graphId, {
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

      // Validate the connection through the same shared inference the backend uses.
      // tryAddEdge on a throwaway clone so a rejection leaves no state behind; on
      // success we still mutate the descriptor (the mirror is rebuilt from it).
      if (mirror) {
        const res = mirror.tryAddEdge({
          fromNodeId: conn.source,
          fromPort,
          toNodeId: conn.target,
          toPort,
        });
        if (!res.ok) {
          // Surface the reason; reject the drop (no descriptor mutation).
          window.dispatchEvent(
            new CustomEvent('vspark:graph-connect-rejected', {
              detail: { reason: res.reason },
            })
          );
          console.warn(`[SignalGraphCanvas] connection refused: ${res.reason}`);
          return;
        }
      }

      // Edge transport derives from the target input port's resolved type
      // (list target → 'list' fan-in), else the source output's transport.
      const srcType = mirror?.outputType(conn.source, fromPort);
      const dstType = mirror?.inputType(conn.target, toPort);
      const edgeKind: GraphEdgeDescriptor['kind'] =
        dstType && transportOf(dstType) === 'list'
          ? 'list'
          : srcType && transportOf(srcType) === 'event'
            ? 'event'
            : 'value';

      mutateDescriptor((d) => {
        const key = `${conn.source}:${fromPort}:${conn.target}:${toPort}`;
        if (
          d.edges.some(
            (e) =>
              `${e.fromNodeId}:${e.fromPort}:${e.toNodeId}:${e.toPort}` === key
          )
        )
          return d;
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
    [mutateDescriptor, mirror]
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

  // ── copy / paste ────────────────────────────────────────────────────────
  //
  // Cmd/Ctrl+C copies the React Flow selection (nodes + edges-between-them)
  // to the clipboard. Cmd/Ctrl+V mints fresh ids, offsets positions by
  // +(40, 40), appends to the active descriptor, and re-selects the pasted
  // nodes. Listens on window so the user doesn't need to focus the canvas
  // div first, but guards on the active element being inside the wrapper
  // (and not a text input) so the shortcut doesn't fire while editing
  // a property panel field.
  const clipboardPayload = useEditorStore((s) => s.clipboardPayload);
  const setClipboard = useEditorStore((s) => s.setClipboard);
  useEffect(() => {
    const isEditableTarget = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      return false;
    };

    const onKey = (ev: KeyboardEvent) => {
      if (!writable) return;
      const meta = ev.metaKey || ev.ctrlKey;
      if (!meta) return;
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      // Active element must be inside the canvas wrapper, and must NOT be a
      // text input (so editing a literal field with Ctrl+V still pastes
      // text into the input).
      const active = document.activeElement;
      if (!active || !wrapper.contains(active)) return;
      if (isEditableTarget(active)) return;

      const key = ev.key.toLowerCase();
      if (key === 'c') {
        const selectedNodes = nodes.filter((n) => n.selected);
        if (selectedNodes.length === 0) return;
        const selectedIds = new Set(selectedNodes.map((n) => n.id));
        const d = editableRef.current;
        if (!d) return;
        const copiedNodes = d.nodes.filter((n) => selectedIds.has(n.id));
        const copiedEdges = d.edges.filter(
          (e) => selectedIds.has(e.fromNodeId) && selectedIds.has(e.toNodeId)
        );
        ev.preventDefault();
        void copyToClipboard(
          { kind: 'graph-nodes', nodes: copiedNodes, edges: copiedEdges },
          setClipboard
        );
        return;
      }
      if (key === 'v') {
        ev.preventDefault();
        void pasteFromClipboard(clipboardPayload).then((payload) => {
          if (!payload || payload.kind !== 'graph-nodes') return;
          // Mint a fresh id for every pasted node; rewrite edge endpoints
          // to the new ids. Offset positions by a fixed delta so the paste
          // doesn't overlap the source. Existing ids in the descriptor are
          // never touched.
          const idMap = new Map<string, string>();
          for (const n of payload.nodes) idMap.set(n.id, randomNodeId());
          const newNodes = payload.nodes.map((n) => ({
            ...n,
            id: idMap.get(n.id)!,
            position: { x: (n.position?.x ?? 0) + 40, y: (n.position?.y ?? 0) + 40 },
          }));
          const newEdges = payload.edges.map((e) => ({
            ...e,
            fromNodeId: idMap.get(e.fromNodeId) ?? e.fromNodeId,
            toNodeId: idMap.get(e.toNodeId) ?? e.toNodeId,
          }));
          mutateDescriptor((d) => ({
            ...d,
            nodes: [...d.nodes, ...newNodes],
            edges: [...d.edges, ...newEdges],
          }));
          // Re-select the pasted nodes (and only those). The next build
          // pass picks this up via mergeNodes' selected pass-through.
          const newIds = new Set(idMap.values());
          setNodes((ns) =>
            ns.map((n) => ({ ...n, selected: newIds.has(n.id) }))
          );
        });
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    writable,
    nodes,
    clipboardPayload,
    setClipboard,
    mutateDescriptor,
    setNodes,
  ]);

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
      // tabIndex makes the wrapper focusable so Cmd/Ctrl+C/V land inside
      // it (the window-level keydown handler requires document.activeElement
      // to be within the wrapper). outline:none so the focus ring doesn't
      // show — the React Flow background is the visual focus indicator.
      tabIndex={-1}
      style={{
        width: '100%',
        height: '100%',
        background: '#0d0d0d',
        outline: 'none',
      }}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onMouseEnter={() => wrapperRef.current?.focus()}
    >
      {rejectMsg && (
        <div
          style={{
            position: 'absolute',
            top: 10,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10,
            background: '#3a1a1a',
            border: '1px solid #c87070',
            color: '#f0b0b0',
            borderRadius: 6,
            padding: '6px 12px',
            fontSize: 12,
            fontFamily: 'monospace',
            maxWidth: '80%',
            pointerEvents: 'none',
          }}
        >
          ⚠ Connection refused: {rejectMsg}
        </div>
      )}
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
