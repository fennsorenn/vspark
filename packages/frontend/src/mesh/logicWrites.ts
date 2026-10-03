/**
 * Signal-graph (logic) writes on the mesh.
 *
 * Logic was the only document type with no sync at all: the panels re-polled
 * REST every three seconds and the graph canvas PUT the whole descriptor on a
 * debounce. Two people editing one graph overwrote each other, and neither had
 * any way to notice. Reads come from the feeder now; writes come from here.
 *
 * The descriptor IS the program, so a committed write restarts the running
 * instance — handled in the backend's onCommitted tap (logic/lifecycle.ts), the
 * same way a behavior's signal graph is.
 *
 * Ownership is polymorphic (project / scene_node / compose_layer), which the
 * document carries as `ownerKind` + `ownerId`; a create just has to say which.
 */
import {
  commitDocCreate,
  commitDocDelete,
  commitDocPatch,
  commitDocPath,
  type MeshDocAdapter,
} from './writes';
import { getMeshHandles, meshBatch } from './peer';
import {
  edgeKey,
  toDescriptorDoc,
  type GraphEdgeDescriptor,
  type GraphNodeDescriptor,
} from '@vspark/shared/signal';
import { useEditorStore } from '../store/editorStore';
import { api, type LogicRecord } from '../api/client';

export type LogicOwner =
  | { kind: 'project'; id: string }
  | { kind: 'scene_node'; id: string }
  | { kind: 'compose_layer'; id: string };

const graphs: MeshDocAdapter<LogicRecord> = {
  rtype: 'logic',
  list: () => Object.values(useEditorStore.getState().logic),
  applyLocal: (id, patch) => {
    const cur = useEditorStore.getState().logic[id];
    if (cur) useEditorStore.getState().upsertLogic({ ...cur, ...patch });
  },
  addLocal: (doc) => useEditorStore.getState().upsertLogic(doc),
  removeLocal: (id) => useEditorStore.getState().removeLogicLocal(id),
  restUpdate: (id, patch) => api.updateLogic(id, patch),
  restDelete: (id) => api.deleteLogic(id),
  // A graph owns nothing: no subtree delete, no reparenting.
  childrenOf: () => [],
  parentPatch: () => ({}),
};

/** Graphs owned by one entity, in creation order. */
export const logicFor = (owner: LogicOwner): LogicRecord[] =>
  Object.values(useEditorStore.getState().logic)
    .filter((g) => g.ownerKind === owner.kind && g.ownerId === owner.id)
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));

export const commitLogicPath = (
  id: string,
  path: string,
  value: unknown
): void => commitDocPath(graphs, id, path, value);

export const commitLogicPatch = (
  id: string,
  patch: Partial<LogicRecord>
): void => commitDocPatch(graphs, id, patch);

export const commitLogicDelete = (id: string): Promise<boolean> =>
  commitDocDelete(graphs, id);

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
  const col = getMeshHandles()?.collections.logic;
  if (!col?.canWrite() || !col.get(logicId)) return;
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

/** Create a graph on any owner. The id is minted here so the create is authored
 *  by this tab and lands on its undo stack; every create route now accepts it. */
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
  const wire = {
    ...doc,
    descriptor: toDescriptorDoc(doc.descriptor),
  } as unknown as LogicRecord;
  return commitDocCreate(graphs, wire, async () => {
    const created =
      owner.kind === 'project'
        ? await api.createProjectLogic(owner.id, name)
        : owner.kind === 'scene_node'
          ? await api.createNodeLogic(owner.id, name)
          : await api.createLayerLogic(owner.id, name);
    // The REST creates take a name only, so a supplied descriptor is a second
    // call on this path — unlike the mesh write, which carries it in one op.
    if (descriptor) await api.updateLogic(created.id, { descriptor });
    return { ...created, ...(descriptor ? { descriptor } : {}) };
  }).then(() => doc);
}
