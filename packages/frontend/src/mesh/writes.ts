/**
 * Mesh write primitives for UI code (§11 frontend writes).
 *
 * The read half is already mesh-backed: {@link ../sync/meshStoreFeeder} mirrors
 * the tab replica into `editorStore`, and `peer.localWrite` applies to the local
 * replica *before* the authority ack. So a committed write re-renders through
 * the normal selector path immediately — there is no optimistic store write to
 * make, and a nacked write rolls back on its own.
 *
 * Two levels, matching the mesh's own channels (packages/mesh/src/channels.ts):
 *
 *   - `preview*` — live, uncommitted. Local store only: no mesh traffic, no
 *     undo entry. This is the value a control shows mid-gesture.
 *   - `commit*` — a retained `committed` write: persisted by the backend tap
 *     and logged on this tab's undo stack (see mesh/peer.ts §undo).
 *
 * The helpers are generic over document type: an rtype supplies a
 * {@link MeshDocAdapter} saying where its docs live in the store and which REST
 * route backs them, and everything below — the fallback ladder, the merge-patch
 * rebuild, the batched bottom-up subtree delete — is shared. Thin per-rtype
 * wrappers (`commitNodePath`, …) keep call sites reading naturally.
 *
 * Commit granularity is therefore a UI decision, and it matters: every committed
 * write is one undo step, so a control that commits per keystroke makes undo
 * useless. Bind controls with {@link ../hooks/useMeshField}, which owns that
 * split, rather than calling `commitNodePath` from an `onChange`.
 *
 * Dotted paths are native (`Collection.set(id, path, value)`), so an edit stamps
 * exactly its own path. Two clients editing different fields of the same node no
 * longer clobber each other the way the whole-doc REST PUT did.
 *
 * Fallback ladder for commits — mesh is skipped, REST takes over, when:
 *   - the doc is owner-authoritative (a Phase-6 projection; api/client's
 *     `remoteWriteRouter` diverts those to the owner), or
 *   - the tab peer isn't armed / the authority is offline (`canWrite()`), or
 *   - the replica doesn't hold the doc yet.
 *
 * ## Structural edits
 *
 * Creates, deletes and reparents are committed here too, so the whole CRUD
 * surface is undoable by the tab that authored it. Two things make that safe:
 *
 *   - The backend validates client-authored whole-doc writes in its mesh
 *     `validate` hook (e.g. backend mesh/docGuards.ts) and returns a
 *     nack, which rolls the client's optimistic write back. So a create the
 *     REST route would have refused is refused here on the same grounds.
 *   - A delete removes the doc's descendants EXPLICITLY, each before its
 *     parent, inside one `meshBatch`. Relying on the server's FK cascade would
 *     tombstone only the root, and undo would then restore a doc whose children
 *     are gone from the database for good.
 *
 * Anything that spans several writes belongs in a `meshBatch` so the user
 * undoes the action rather than its individual writes.
 */
import { flattenToLeaves, getPath, setPath } from '@vspark/mesh';
import { getMeshHandles, meshBatch } from './peer';
import { useEditorStore, type StageObject } from '../store/editorStore';
import { api } from '../api/client';

/** Everything a document type has to supply for the generic write helpers.
 *
 *  The helpers below own the parts that were subtly wrong the first time and
 *  are now pinned by tests — the mesh/REST fallback ladder, the merge-patch
 *  rebuild, and the batched bottom-up subtree delete. An rtype supplies only
 *  what actually differs: where its docs live in the store, and which REST
 *  route backs them. */
export interface MeshDocAdapter<T extends { id: string }> {
  rtype: string;
  /** Current docs of this type in the store. */
  list(): T[];
  /** Apply a partial locally. Only the REST fallback needs it — a mesh write
   *  echoes back through the store feeder on its own. */
  applyLocal(id: string, patch: Partial<T>): void;
  addLocal(doc: T): void;
  removeLocal(id: string): void;
  restUpdate(id: string, patch: Partial<T>): Promise<unknown>;
  restDelete(id: string): Promise<unknown>;
  /** Direct children of `id` — the containment the subtree delete walks. */
  childrenOf(id: string): T[];
  /** The patch that re-parents a doc, for "delete but keep children". */
  parentPatch(parentId: string | null): Partial<T>;
  /** True for docs another peer is authoritative for (Phase-6 projections),
   *  which must travel their own relay rather than our mesh. */
  isRemote?(doc: T): boolean;
}

const find = <T extends { id: string }>(
  a: MeshDocAdapter<T>,
  id: string
): T | undefined => a.list().find((d) => d.id === id);

const mine = <T extends { id: string }>(
  a: MeshDocAdapter<T>,
  doc: T
): boolean => !a.isRemote?.(doc);

/** Whether the tab peer can author writes right now (armed + authority online).
 *  UI may use this to explain why an edit fell back to REST; the write helpers
 *  below already check it themselves. */
export function canMeshWrite(rtype = 'scene_node'): boolean {
  return getMeshHandles()?.collections[rtype]?.canWrite() ?? false;
}

/** Committed write onto the tab peer — a dotted-path replace when `path` is
 *  given, else a merge-patch of `value` (flattened to leaves under one stamp).
 *  Either way it is a single op, so a single undo step. False when the peer
 *  can't author it or the replica doesn't hold the doc — the caller falls back. */
function meshWrite(
  rtype: string,
  id: string,
  path: string | null,
  value: unknown
): boolean {
  const col = getMeshHandles()?.collections[rtype];
  if (!col?.canWrite()) return false;
  if (!col.get(id)) return false;
  if (path === null) col.update(id, value as object);
  else col.set(id, path, value);
  return true;
}

/** The whole-field partial equivalent of a dotted-path write. REST and the
 *  Phase-6 relay both take whole top-level fields rather than paths, so the
 *  spine is rebuilt from the current doc and the touched field sent whole. */
function topLevelPatch<T extends object>(
  doc: T,
  path: string,
  value: unknown
): Partial<T> {
  const field = path.split('.')[0] as keyof T;
  const next = setPath(doc, path, value);
  return { [field]: next[field] } as Partial<T>;
}

/** Read the current value at `path` on a doc (undefined if absent). */
export function readDocPath<T extends { id: string }>(
  a: MeshDocAdapter<T>,
  id: string,
  path: string
): unknown {
  const doc = find(a, id);
  return doc ? getPath(doc, path) : undefined;
}

/** Live, uncommitted edit, LOCAL ONLY: applies to this tab's store so the
 *  viewport and panels track the gesture, and goes nowhere else.
 *
 *  Prefer {@link previewDocFields} for anything another peer should see —
 *  this one emits no mesh traffic at all. */
export function previewDocPath<T extends { id: string }>(
  a: MeshDocAdapter<T>,
  id: string,
  path: string,
  value: unknown
): void {
  const doc = find(a, id);
  if (!doc) return;
  a.applyLocal(id, topLevelPatch(doc, path, value));
}

/** In-flight gesture values, on the mesh's lossy `preview` channel.
 *
 *  An ephemeral write lands as a per-key overlay composed over the retained
 *  doc, so watching tabs see the gesture without it ever becoming model state —
 *  no persistence, no undo entry, and the overlay clears the moment the
 *  committed write arrives.
 *
 *  ONE OVERLAY PER PATH, always. A pathless ephemeral write is a *root* overlay:
 *  it clears the per-path ones and replaces the composed doc wholesale, so
 *  `{x: 400}` would compose to a doc that is only `{x: 400}` — losing the id
 *  along with everything else. Paths must also be as deep as the value being
 *  driven: an overlay at `components.transform` would blank every sibling field
 *  on that component (opacity, shadow flags) for the whole gesture, so a node
 *  gesture writes `components.transform.x`, not `components.transform`. */
export function previewDocFields<T extends { id: string }>(
  a: MeshDocAdapter<T>,
  id: string,
  patch: Record<string, unknown>
): void {
  const col = getMeshHandles()?.collections[a.rtype];
  if (col?.canWrite() && col.get(id)) {
    for (const [path, value] of Object.entries(patch))
      col.set(id, path, value, { channel: 'preview' });
    return;
  }
  // No peer to fan out to — still show the gesture locally. Accumulate so that
  // sibling paths under one top-level field don't each rebuild it from the
  // stored doc and drop the ones before them.
  const doc = find(a, id);
  if (!doc) return;
  let merged = doc;
  for (const [path, value] of Object.entries(patch))
    merged = setPath(merged, path, value);
  const fields = new Set(Object.keys(patch).map((p) => p.split('.')[0]));
  const local: Record<string, unknown> = {};
  for (const f of fields) local[f] = (merged as Record<string, unknown>)[f];
  a.applyLocal(id, local as Partial<T>);
}

/** Commit one field. One call = one undo step. */
export function commitDocPath<T extends { id: string }>(
  a: MeshDocAdapter<T>,
  id: string,
  path: string,
  value: unknown
): void {
  const doc = find(a, id);
  if (!doc) return;
  if (mine(a, doc) && meshWrite(a.rtype, id, path, value)) return;
  const patch = topLevelPatch(doc, path, value);
  a.applyLocal(id, patch);
  void a.restUpdate(id, patch).catch(() => {});
}

/** Commit a (possibly nested) partial as one op — so an edit that genuinely
 *  spans fields stays a single undo step instead of several.
 *
 *  Merge semantics, matching the mesh: the partial is flattened to leaves, so
 *  `{ components: { godray: { power: 2 } } }` touches only that one leaf and
 *  every sibling survives. A whole-subtree *replace* is {@link commitDocPath}
 *  with that path.
 *
 *  REST can't express any of that — `PUT` replaces a field wholesale — so the
 *  fallback rebuilds each touched top-level field from the current doc and
 *  sends it whole, reproducing the same result. */
export function commitDocPatch<T extends { id: string }>(
  a: MeshDocAdapter<T>,
  id: string,
  patch: Partial<T>
): void {
  const doc = find(a, id);
  if (!doc) return;
  if (mine(a, doc) && meshWrite(a.rtype, id, null, patch)) return;

  let next = doc;
  for (const [p, v] of flattenToLeaves(patch)) next = setPath(next, p, v);
  const whole = Object.fromEntries(
    Object.keys(patch).map((f) => [f, next[f as keyof T]])
  ) as Partial<T>;
  a.applyLocal(id, whole);
  void a.restUpdate(id, whole).catch(() => {});
}

/** Create a doc the caller has already built (id included, so the write is
 *  authored by this tab and lands on its undo stack). Throws on refusal, like
 *  the REST create it replaces. `restCreate` returns the server's own record
 *  for the fallback path, which mints its own id. */
export async function commitDocCreate<T extends { id: string }>(
  a: MeshDocAdapter<T>,
  doc: T,
  restCreate: () => Promise<T>
): Promise<T> {
  const col = getMeshHandles()?.collections[a.rtype];
  if (col?.canWrite()) {
    const outcome = await col.set(doc.id, '', doc).ack;
    if (outcome.status === 'rejected')
      throw new Error(outcome.reason ?? `${a.rtype} create refused`);
    // The feeder mirrors the replica into the store; nothing to apply here.
    return doc;
  }
  const created = await restCreate();
  if (a.list().every((d) => d.id !== created.id)) a.addLocal(created);
  return created;
}

/** Docs under `rootId` (excluding it), ordered so every doc comes before its
 *  own parent — the order a subtree has to be removed in, so each doc gets its
 *  own tombstone and undo entry and no parent is removed out from under a
 *  child still to come. (Undo then replays it in reverse, restoring parents
 *  first.) Depth-first preorder puts a parent ahead of its descendants, so
 *  reversing it gives exactly that. */
function descendantsBottomUp<T extends { id: string }>(
  a: MeshDocAdapter<T>,
  rootId: string
): T[] {
  const out: T[] = [];
  const walk = (id: string) => {
    for (const c of a.childrenOf(id)) {
      out.push(c);
      walk(c.id);
    }
  };
  walk(rootId);
  return out.reverse();
}

/** Delete a doc and everything under it, as ONE undo action.
 *
 *  Descendants are removed explicitly rather than left to the server's FK
 *  cascade, so each one carries a tombstone and can be restored. Undo re-creates
 *  the whole subtree; without this it would restore the root alone and the
 *  children would be unrecoverable. */
export async function commitDocDelete<T extends { id: string }>(
  a: MeshDocAdapter<T>,
  id: string
): Promise<boolean> {
  const doc = find(a, id);
  if (!doc) return false;
  const col = getMeshHandles()?.collections[a.rtype];
  const subtree = descendantsBottomUp(a, id);

  if (mine(a, doc) && col?.canWrite() && col.get(id)) {
    const acks = meshBatch(() => [
      ...subtree.map((d) => col.remove(d.id).ack),
      col.remove(id).ack,
    ]);
    const outcomes = await Promise.all(acks);
    return outcomes.every((o) => o.status !== 'rejected');
  }

  const ok = await a
    .restDelete(id)
    .then(() => true)
    .catch(() => false);
  if (ok) {
    for (const d of subtree) a.removeLocal(d.id);
    a.removeLocal(id);
  }
  return ok;
}

/** Re-parent a doc's direct children onto `newParentId`, then delete it — one
 *  undo action, so "delete but keep children" reverses in a single step. */
export async function commitDocDeleteKeepChildren<T extends { id: string }>(
  a: MeshDocAdapter<T>,
  id: string,
  newParentId: string | null
): Promise<boolean> {
  const doc = find(a, id);
  if (!doc) return false;
  const children = a.childrenOf(id);
  const col = getMeshHandles()?.collections[a.rtype];

  if (mine(a, doc) && col?.canWrite() && col.get(id)) {
    const acks = meshBatch(() => [
      ...children.map((c) => col.set(c.id, 'parentId', newParentId).ack),
      col.remove(id).ack,
    ]);
    const outcomes = await Promise.all(acks);
    return outcomes.every((o) => o.status !== 'rejected');
  }

  for (const c of children) {
    const patch = a.parentPatch(newParentId);
    a.applyLocal(c.id, patch);
    await a.restUpdate(c.id, patch).catch(() => {});
  }
  const ok = await a
    .restDelete(id)
    .then(() => true)
    .catch(() => false);
  if (ok) a.removeLocal(id);
  return ok;
}

// --- scene_node ---------------------------------------------------------------

const nodes: MeshDocAdapter<StageObject> = {
  rtype: 'scene_node',
  list: () => useEditorStore.getState().nodes,
  applyLocal: (id, patch) => useEditorStore.getState().updateNode(id, patch),
  addLocal: (doc) => useEditorStore.getState().addNode(doc),
  removeLocal: (id) => useEditorStore.getState().deleteNode(id),
  restUpdate: (id, patch) => api.updateNode(id, patch),
  restDelete: (id) => api.deleteNode(id),
  childrenOf: (id) =>
    useEditorStore.getState().nodes.filter((n) => n.parentId === id),
  parentPatch: (parentId) => ({ parentId }),
  isRemote: (n) => n.remote === true,
};

export const readNodePath = (nodeId: string, path: string): unknown =>
  readDocPath(nodes, nodeId, path);

export const previewNodePath = (
  nodeId: string,
  path: string,
  value: unknown
): void => previewDocPath(nodes, nodeId, path, value);

/** In-flight transform values for a node gesture, fanned out on the mesh
 *  `preview` channel. See {@link previewDocFields}.
 *
 *  Takes the flat gesture payload (`{x, y, rx, …}`) and writes ONE overlay PER
 *  SCALAR, at `components.transform.<field>`. Not one overlay at
 *  `components.transform`: that would blank the component's other fields —
 *  opacity, castShadow, receiveShadow — for every watching tab for the duration
 *  of the drag, which is the live-preview twin of the commit bug fixed in
 *  `mergedTransform`. */
export const previewNodeTransform = (
  nodeId: string,
  transform: Record<string, number>
): void =>
  previewDocFields(
    nodes,
    nodeId,
    Object.fromEntries(
      Object.entries(transform).map(([f, v]) => [
        `components.transform.${f}`,
        v,
      ])
    )
  );

export const commitNodePath = (
  nodeId: string,
  path: string,
  value: unknown
): void => commitDocPath(nodes, nodeId, path, value);

export const commitNodePatch = (
  nodeId: string,
  patch: Partial<StageObject>
): void => commitDocPatch(nodes, nodeId, patch);

export const commitNodeDelete = (nodeId: string): Promise<boolean> =>
  commitDocDelete(nodes, nodeId);

export const commitNodeDeleteKeepChildren = (
  nodeId: string,
  newParentId: string | null
): Promise<boolean> => commitDocDeleteKeepChildren(nodes, nodeId, newParentId);

/** Create a node. The id is minted here so the create is authored by this tab;
 *  the backend re-derives `projectId` and validates the doc, nacking anything
 *  it would have refused over REST. */
export function commitNodeCreate(
  sceneId: string,
  spec: {
    name: string;
    kind: string;
    parentId?: string | null;
    boneAttachment?: string | null;
    filePath?: string | null;
    components?: Record<string, unknown>;
    properties?: StageObject['properties'];
  }
): Promise<StageObject> {
  const doc: StageObject = {
    id: crypto.randomUUID(),
    rootSceneNodeId: sceneId,
    projectId: useEditorStore.getState().projectId ?? '',
    parentId: spec.parentId ?? null,
    boneAttachment: spec.boneAttachment ?? null,
    name: spec.name,
    kind: spec.kind,
    filePath: spec.filePath ?? null,
    components: spec.components ?? {},
    properties: spec.properties ?? {},
    hidden: false,
  };
  return commitDocCreate(
    nodes,
    doc,
    // Same fields, normalized — REST requires `components` and mints its own id.
    () =>
      api.createNode(sceneId, {
        name: doc.name,
        kind: doc.kind,
        parentId: doc.parentId,
        boneAttachment: doc.boneAttachment,
        filePath: doc.filePath,
        components: doc.components,
        properties: doc.properties,
        hidden: false,
      }) as Promise<StageObject>
  );
}
