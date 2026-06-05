/**
 * Edge-time structural type inference (Phase 2).
 *
 * `InferGraph` is a shared, engine-agnostic model of a graph's resolved port types.
 * Both the backend `SignalGraph` and the frontend editor wrap one: when an edge is
 * added (by the user dragging or the descriptor loader replaying), the downstream
 * node's ports are recomputed from its connected inputs and propagated forward.
 * Incompatible edges are rejected with a reason; a downstream conflict rolls the whole
 * add back (transactional). Because adding the loop-closing edge of a cycle is just
 * another `tryAddEdge`, there is no special cycle handling.
 *
 * A node's resolved ports come from its `inferPorts` (looked up by kind in
 * `INFER_BY_KIND`) or, for ordinary nodes, from `defaultInfer` lifting the static
 * port declarations. The same table is imported by the frontend so FE and BE never
 * drift.
 */

import type { PortMeta, InferCtx, InferResult } from './node.js';
import {
  type ResolvedType,
  type ResolvedPort,
  RT,
  isAssignable,
  typeTagToResolved,
  describeResolvedType,
} from './signal_types.js';

// ──────────────────────────────────────────────────────────────────────────────
// defaultInfer — lift static port declarations into resolved ports
// ──────────────────────────────────────────────────────────────────────────────

export function defaultInfer(ports: PortMeta[]): InferResult {
  const inputPorts: ResolvedPort[] = [];
  const outputPorts: ResolvedPort[] = [];
  for (const p of ports) {
    const rp: ResolvedPort = {
      name: p.name,
      type: typeTagToResolved(p.typeTag, p.transport),
    };
    if (p.direction === 'in') inputPorts.push(rp);
    else outputPorts.push(rp);
  }
  return { inputPorts, outputPorts };
}

// ──────────────────────────────────────────────────────────────────────────────
// InferGraph
// ──────────────────────────────────────────────────────────────────────────────

export type InferPortsFn = (
  ctx: InferCtx,
  staticPorts: PortMeta[]
) => InferResult;

export interface InferEdge {
  fromNodeId: string;
  fromPort: string;
  toNodeId: string;
  toPort: string;
}

interface InferNode {
  id: string;
  kind: string;
  staticPorts: PortMeta[];
  config: unknown;
  resolvedInputs: Map<string, ResolvedType>;
  resolvedInputPorts: ResolvedPort[];
  resolvedOutputPorts: ResolvedPort[];
}

export type TryAddResult = { ok: true } | { ok: false; reason: string };

export class InferGraph {
  private readonly _nodes = new Map<string, InferNode>();
  private readonly _edges: InferEdge[] = [];

  /**
   * @param inferFor  resolves a kind's inferPorts function (or undefined → defaultInfer).
   *                  Typically `(kind) => INFER_BY_KIND[kind]`.
   * @param portsFor  resolves a kind's static port declarations.
   * @param ownerKind owner kind of the graph (threaded into every node's InferCtx
   *                  so scope-aware nodes can vary their ports). Optional.
   */
  constructor(
    private readonly inferFor: (kind: string) => InferPortsFn | undefined,
    private readonly portsFor: (kind: string) => PortMeta[],
    private readonly ownerKind?: import('./types.js').GraphOwnerKind
  ) {}

  addNode(id: string, kind: string, config: unknown): void {
    const staticPorts = this.portsFor(kind);
    const node: InferNode = {
      id,
      kind,
      staticPorts,
      config,
      resolvedInputs: new Map(),
      resolvedInputPorts: [],
      resolvedOutputPorts: [],
    };
    this._nodes.set(id, node);
    this._reinfer(node);
  }

  /** Update a node's config (e.g. pack_event field rename) and re-infer + propagate. */
  setConfig(id: string, config: unknown): TryAddResult {
    const node = this._nodes.get(id);
    if (!node) return { ok: false, reason: `unknown node ${id}` };
    const snapshot = this._snapshot([id, ...this._downstreamClosure(id)]);
    node.config = config;
    this._reinfer(node);
    const conflict = this._propagate(id);
    if (conflict) {
      this._restore(snapshot);
      return { ok: false, reason: conflict };
    }
    return { ok: true };
  }

  removeNode(id: string): void {
    for (let i = this._edges.length - 1; i >= 0; i--) {
      const e = this._edges[i];
      if (e.fromNodeId === id || e.toNodeId === id) this.removeEdge(e);
    }
    this._nodes.delete(id);
  }

  /** Resolved input + output ports for a node (what the editor renders). */
  portsOf(id: string): {
    inputPorts: ResolvedPort[];
    outputPorts: ResolvedPort[];
  } {
    const n = this._nodes.get(id);
    if (!n) return { inputPorts: [], outputPorts: [] };
    return {
      inputPorts: n.resolvedInputPorts,
      outputPorts: n.resolvedOutputPorts,
    };
  }

  outputType(id: string, port: string): ResolvedType | undefined {
    return this._nodes.get(id)?.resolvedOutputPorts.find((p) => p.name === port)
      ?.type;
  }

  inputType(id: string, port: string): ResolvedType | undefined {
    return this._nodes.get(id)?.resolvedInputPorts.find((p) => p.name === port)
      ?.type;
  }

  hasEdge(e: InferEdge): boolean {
    return this._edges.some(
      (x) =>
        x.fromNodeId === e.fromNodeId &&
        x.fromPort === e.fromPort &&
        x.toNodeId === e.toNodeId &&
        x.toPort === e.toPort
    );
  }

  /**
   * Validate and add an edge. On success the target re-infers and the new shape
   * propagates forward; on a downstream conflict the whole operation rolls back.
   */
  tryAddEdge(e: InferEdge): TryAddResult {
    const src = this._nodes.get(e.fromNodeId);
    const dst = this._nodes.get(e.toNodeId);
    if (!src)
      return { ok: false, reason: `unknown source node ${e.fromNodeId}` };
    if (!dst) return { ok: false, reason: `unknown target node ${e.toNodeId}` };

    const srcType = this.outputType(e.fromNodeId, e.fromPort);
    if (!srcType)
      return {
        ok: false,
        reason: `${e.fromNodeId} has no output port "${e.fromPort}"`,
      };
    const dstType = this.inputType(e.toNodeId, e.toPort);
    if (!dstType)
      return {
        ok: false,
        reason: `${e.toNodeId} has no input port "${e.toPort}"`,
      };

    if (!isAssignable(srcType, dstType)) {
      return {
        ok: false,
        reason: `type mismatch: ${describeResolvedType(srcType)} is not assignable to ${describeResolvedType(dstType)}`,
      };
    }

    // Snapshot the target + everything downstream of it (the propagation frontier),
    // so a conflict anywhere downstream can be fully rolled back.
    const affected = [e.toNodeId, ...this._downstreamClosure(e.toNodeId)];
    const snapshot = this._snapshot(affected);

    dst.resolvedInputs.set(e.toPort, srcType);
    this._reinfer(dst);
    const conflict = this._propagate(e.toNodeId);
    if (conflict) {
      this._restore(snapshot);
      return { ok: false, reason: conflict };
    }

    this._edges.push({ ...e });
    return { ok: true };
  }

  removeEdge(e: InferEdge): void {
    const i = this._edges.findIndex(
      (x) =>
        x.fromNodeId === e.fromNodeId &&
        x.fromPort === e.fromPort &&
        x.toNodeId === e.toNodeId &&
        x.toPort === e.toPort
    );
    if (i < 0) return;
    this._edges.splice(i, 1);

    const dst = this._nodes.get(e.toNodeId);
    if (!dst) return;
    // If another edge still feeds this input port, recompute from it; else clear.
    const stillFed = this._edges.find(
      (x) => x.toNodeId === e.toNodeId && x.toPort === e.toPort
    );
    if (stillFed) {
      dst.resolvedInputs.set(
        e.toPort,
        this.outputType(stillFed.fromNodeId, stillFed.fromPort) ?? RT.unknown()
      );
    } else {
      dst.resolvedInputs.delete(e.toPort);
    }
    this._reinfer(dst);
    // Removal can only loosen types (an input went to unknown), which is always
    // assignable downstream — so propagation here never rejects.
    this._propagate(e.toNodeId);
  }

  edges(): readonly InferEdge[] {
    return this._edges;
  }

  // ── internal ────────────────────────────────────────────────────────────────

  private _reinfer(node: InferNode): void {
    const ctx: InferCtx = {
      resolvedInputs: Object.fromEntries(node.resolvedInputs),
      config: node.config,
      ownerKind: this.ownerKind,
    };
    const fn = this.inferFor(node.kind);
    const res = fn ? fn(ctx, node.staticPorts) : defaultInfer(node.staticPorts);
    node.resolvedInputPorts = res.inputPorts;
    node.resolvedOutputPorts = res.outputPorts;
  }

  /**
   * After a node re-infers, re-validate every edge leaving it. If an output type
   * changed and is no longer assignable to a downstream input, return that conflict
   * reason (caller rolls back). Otherwise push the new type into each downstream
   * input and recurse. Returns the first conflict reason, or null on success.
   */
  private _propagate(fromId: string): string | null {
    for (const edge of this._edges.filter((x) => x.fromNodeId === fromId)) {
      const srcType = this.outputType(edge.fromNodeId, edge.fromPort);
      const dst = this._nodes.get(edge.toNodeId);
      if (!srcType || !dst) continue;
      const dstType = this.inputType(edge.toNodeId, edge.toPort);
      if (dstType && !isAssignable(srcType, dstType)) {
        return `downstream conflict at ${edge.toNodeId}.${edge.toPort}: ${describeResolvedType(srcType)} not assignable to ${describeResolvedType(dstType)}`;
      }
      dst.resolvedInputs.set(edge.toPort, srcType);
      this._reinfer(dst);
      const deeper = this._propagate(edge.toNodeId);
      if (deeper) return deeper;
    }
    return null;
  }

  /** All node ids reachable downstream of `id` via edges (excludes `id` itself). */
  private _downstreamClosure(id: string): string[] {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of this._edges.filter((x) => x.fromNodeId === cur)) {
        if (!seen.has(e.toNodeId)) {
          seen.add(e.toNodeId);
          stack.push(e.toNodeId);
        }
      }
    }
    return [...seen];
  }

  private _snapshot(ids: string[]): Map<string, InferNode> {
    const snap = new Map<string, InferNode>();
    for (const id of ids) {
      const n = this._nodes.get(id);
      if (!n) continue;
      snap.set(id, {
        ...n,
        resolvedInputs: new Map(n.resolvedInputs),
        resolvedInputPorts: n.resolvedInputPorts.slice(),
        resolvedOutputPorts: n.resolvedOutputPorts.slice(),
      });
    }
    return snap;
  }

  private _restore(snap: Map<string, InferNode>): void {
    for (const [id, saved] of snap) this._nodes.set(id, saved);
  }
}
