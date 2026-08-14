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

/** Create a graph on any owner. The id is minted here so the create is authored
 *  by this tab and lands on its undo stack; every create route now accepts it. */
export function commitLogicCreate(
  owner: LogicOwner,
  name: string,
  descriptor?: LogicRecord['descriptor']
): Promise<LogicRecord> {
  const doc: LogicRecord = {
    id: crypto.randomUUID(),
    ownerKind: owner.kind,
    ownerId: owner.id,
    name,
    enabled: true,
    descriptor: descriptor ?? ({ nodes: [], edges: [] } as never),
  };
  return commitDocCreate(graphs, doc, async () => {
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
  });
}
