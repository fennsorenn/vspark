/**
 * Signal-graph (logic) writes on the mesh.
 *
 * Logic was the only document type with no sync at all: the panels re-polled
 * REST every three seconds and the graph canvas PUT the whole descriptor on a
 * debounce. Two people editing one graph overwrote each other, and neither had
 * any way to notice. Reads come from the replica now (mesh/hooks); writes come from here.
 *
 * The descriptor IS the program, so a committed write restarts the running
 * instance — handled in the backend's onCommitted tap (logic/lifecycle.ts), the
 * same way a behavior's signal graph is.
 *
 * Ownership is polymorphic (project / scene_node / compose_layer), which the
 * document carries as `ownerKind` + `ownerId`; a create just has to say which.
 */
import { collectionOf, createDoc, patchDoc, removeDoc, setField } from './docs';
import { meshBatch } from './peer';
import { logicRecordOf } from './hooks';
import {
  edgeKey,
  toDescriptorDoc,
  type GraphEdgeDescriptor,
  type GraphNodeDescriptor,
} from '@vspark/shared/signal';
import type { LogicRecord, RawLogic } from '../api/client';

export type LogicOwner =
  | { kind: 'project'; id: string }
  | { kind: 'scene_node'; id: string }
  | { kind: 'compose_layer'; id: string };

const RTYPE = 'logic';

/** Graphs owned by one entity, in creation order. */
export const logicFor = (owner: LogicOwner): LogicRecord[] =>
  collectionOf<RawLogic>(RTYPE)
    .all()
    .filter((g) => g.ownerKind === owner.kind && g.ownerId === owner.id)
    .map((g) => logicRecordOf(g)!)
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));

export const commitLogicPath = (
  id: string,
  path: string,
  value: unknown
): void => void setField(RTYPE, id, path, value);

export const commitLogicPatch = (
  id: string,
  patch: Partial<LogicRecord>
): void => void patchDoc(RTYPE, id, patch);

export const commitLogicDelete = (id: string): Promise<boolean> =>
  removeDoc(RTYPE, id);

// --- the descriptor, element by element --------------------------------------
//
// The descriptor is the program, and it is one document field — but its nodes
// and edges are keyed by id, so an edit addresses `descriptor.nodes.<nodeId>`
// rather than replacing the whole graph. That is what lets two people work on
// one graph at once: moving a node and wiring an edge elsewhere no longer
// collide. Deleting is a null at the element's path (idMap.ts).

/** One node's whole record — position, kind, defaultConfig. */
export const commitGraphNode = (
  logicId: string,
  node: GraphNodeDescriptor
): void => commitLogicPath(logicId, `descriptor.nodes.${node.id}`, node);

/** In-flight node drag: an overlay on that node's path, so other tabs watch it
 *  move without it becoming model state or an undo entry. */
export function previewGraphNode(
  logicId: string,
  node: GraphNodeDescriptor
): void {
  const col = collectionOf(RTYPE);
  if (!col.get(logicId)) return;
  col.set(logicId, `descriptor.nodes.${node.id}`, node, { channel: 'preview' });
}

/** One inline literal on a node, without re-sending its siblings. */
export const commitGraphNodeConfig = (
  logicId: string,
  nodeId: string,
  port: string,
  value: unknown
): void =>
  commitLogicPath(
    logicId,
    `descriptor.nodes.${nodeId}.defaultConfig.${port}`,
    value
  );

/** Delete a node AND the edges touching it, as one undo action — an edge to a
 *  node that no longer exists is a dangling program, and the engine would
 *  refuse to build it. */
export function commitGraphNodeDelete(
  logicId: string,
  nodeIds: string[],
  edges: GraphEdgeDescriptor[]
): void {
  const gone = new Set(nodeIds);
  const orphaned = edges.filter(
    (e) => gone.has(e.fromNodeId) || gone.has(e.toNodeId)
  );
  meshBatch(() => {
    for (const e of orphaned)
      commitLogicPath(logicId, `descriptor.edges.${edgeKey(e)}`, null);
    for (const id of gone)
      commitLogicPath(logicId, `descriptor.nodes.${id}`, null);
  });
}

/** Add an edge. Its key is derived from the endpoints, so two peers drawing the
 *  same connection converge instead of duplicating it. */
export const commitGraphEdge = (
  logicId: string,
  edge: GraphEdgeDescriptor
): void => commitLogicPath(logicId, `descriptor.edges.${edgeKey(edge)}`, edge);

export const commitGraphEdgeDelete = (
  logicId: string,
  edge: GraphEdgeDescriptor
): void => commitLogicPath(logicId, `descriptor.edges.${edgeKey(edge)}`, null);

/** Paste: several nodes and edges as ONE undo action. */
export function commitGraphPaste(
  logicId: string,
  nodes: GraphNodeDescriptor[],
  edges: GraphEdgeDescriptor[]
): void {
  meshBatch(() => {
    for (const n of nodes) commitGraphNode(logicId, n);
    for (const e of edges) commitGraphEdge(logicId, e);
  });
}

/** Create a graph on any owner. */
export function commitLogicCreate(
  owner: LogicOwner,
  name: string,
  descriptor?: LogicRecord['descriptor']
): Promise<LogicRecord> {
  const id = crypto.randomUUID();
  const doc: LogicRecord = {
    id,
    ownerKind: owner.kind,
    ownerId: owner.id,
    name,
    enabled: true,
    descriptor: descriptor ?? {
      id,
      label: name,
      readonly: false,
      nodes: [],
      edges: [],
    },
  };
  // The doc goes over in DOCUMENT form (descriptor children keyed by id); the
  // record returned to the caller keeps the runtime form the UI works in.
  return createDoc(RTYPE, {
    ...doc,
    descriptor: toDescriptorDoc(doc.descriptor),
  }).then(() => doc);
}
