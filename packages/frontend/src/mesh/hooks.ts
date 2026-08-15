/**
 * The bridge between this app's peer and `@vspark/mesh-react`.
 *
 * The hooks in that package take a `Collection` as an argument, and this tab's
 * collections only exist once `initMeshPeer()` has resolved — so a component had
 * no way to obtain one, which is why the package sat written, tested and
 * entirely unimported. These hooks close that gap: they yield the collection
 * when there is one, `undefined` before that, and re-render the caller when it
 * arrives.
 *
 * ## What reading through here buys, and what it does not
 *
 * Not "live reads" — `sync/meshStoreFeeder` already keeps the Zustand store
 * live, and most components read it perfectly well. What a collection hook adds
 * is the GRANULARITY: `useMeshDoc(col, id)` re-renders when THAT document
 * changes, where `useEditorStore((s) => s.nodes)` re-renders every subscriber
 * whenever any node anywhere changes.
 *
 * So this is worth reaching for when a component watches one document (or one
 * subtree) out of many, and not worth it for a component that already wants the
 * whole slice.
 *
 * ## Why the store is still the load path
 *
 * The editor hydrates from the REST scene bundle, which usually lands before the
 * mesh subscription snapshot. A component reading the replica directly would
 * therefore render empty during that window. Until the snapshot is the load
 * path, the store remains the thing to read for "show me everything", and these
 * hooks are for the narrower per-document reads where that window doesn't apply
 * (a doc the user has already selected, so both sources are populated).
 */
import { useEffect, useState } from 'react';
import { useCanWrite, useMeshDoc } from '@vspark/mesh-react';
import type { Collection, MeshPeer } from '@vspark/mesh';
import { getMeshHandles, onMeshReady, type MeshHandles } from './peer';
import { useEditorStore, type StageObject } from '../store/editorStore';
import type { ComposeLayerRecord } from '../api/client';

type Dto = Record<string, unknown>;

/** The tab's handles once the peer is up, `null` before. Re-renders on arrival. */
export function useMeshHandles(): MeshHandles | null {
  const [handles, setHandles] = useState<MeshHandles | null>(() =>
    getMeshHandles()
  );
  useEffect(() => onMeshReady(setHandles), []);
  return handles;
}

/** One bound collection, or `undefined` before the peer is up. */
export function useMeshCollection<T extends object = Dto>(
  rtype: string
): Collection<T> | undefined {
  return useMeshHandles()?.collections[rtype] as Collection<T> | undefined;
}

/** The tab's peer, or `undefined` before it is up. */
export function useMeshPeer(): MeshPeer | undefined {
  return useMeshHandles()?.peer;
}

/**
 * Whether an edit to this rtype can currently land on the mesh.
 *
 * `false` means the tab peer isn't up or its authority is unreachable. Writes
 * still work in that state — the helpers fall back to REST — so this is not a
 * disable signal on its own. It is the honest input for telling the user that
 * an edit is taking the slower path, next to {@link ./writeFeedback}, which
 * tells them when one was refused outright.
 *
 * Returns `true` when the peer is not up at all: a control must not render
 * disabled during the async init window, when nothing is wrong yet.
 */
export function useMeshCanWrite(rtype: string): boolean {
  const handles = useMeshHandles();
  const col = handles?.collections[rtype];
  return useCanWriteSafe(handles?.peer, col);
}

/** `useCanWrite` needs both a peer and a collection; hooks must be called
 *  unconditionally, so the null window is handled here rather than by every
 *  caller writing the same guard. */
function useCanWriteSafe(
  peer: MeshPeer | undefined,
  col: Collection<Dto> | undefined
): boolean {
  // A stand-in with the same shape keeps the hook call unconditional while the
  // peer is still starting. `onStatus` returns a no-op unsubscribe, so nothing
  // is registered and nothing leaks.
  const stubPeer = usePeerStub();
  const stubCol = useColStub();
  return useCanWrite(peer ?? stubPeer, col ?? stubCol);
}

let _peerStub: MeshPeer | null = null;
let _colStub: Collection<Dto> | null = null;

function usePeerStub(): MeshPeer {
  if (!_peerStub)
    _peerStub = {
      status: () => ({ peers: [], pending: 0 }),
      onStatus: () => () => {},
    } as unknown as MeshPeer;
  return _peerStub;
}

function useColStub(): Collection<Dto> {
  if (!_colStub)
    // `true`, not `false`: before the peer exists nothing is wrong, and a
    // control that renders itself as degraded during startup is lying.
    _colStub = { canWrite: () => true } as unknown as Collection<Dto>;
  return _colStub;
}

// --- per-document reads ------------------------------------------------------

/**
 * One scene node, watched individually.
 *
 * The point is granularity: a component that needs ONE node currently
 * subscribes to `s.nodes` and re-renders whenever any node anywhere changes.
 * This re-renders only when that node does.
 *
 * The store is the fallback, and the rule is "whichever has the document",
 * not "whichever is newer" — they cannot disagree. The feeder writes the
 * replica into the store, so once both hold a document they hold the same one;
 * the only asymmetry is the startup window where the REST bundle has landed and
 * the mesh snapshot has not. Reading the store there is what stops a freshly
 * opened editor from flashing empty.
 *
 * When the mesh snapshot becomes the load path, the fallback goes away here,
 * once, rather than at every call site.
 */
export function useSceneNode(id: string | null | undefined) {
  const col = useMeshCollection('scene_node');
  const fromMesh = useMeshDoc(col ?? EMPTY_COL, id ?? '');
  const fromStore = useEditorStore((s) =>
    id ? s.nodes.find((n) => n.id === id) : undefined
  );
  if (!id) return undefined;
  return (fromMesh as unknown as StageObject | undefined) ?? fromStore;
}

/** One compose layer, watched individually. Same contract as
 *  {@link useSceneNode}. */
export function useComposeLayer(id: string | null | undefined) {
  const col = useMeshCollection('compose_layer');
  const fromMesh = useMeshDoc(col ?? EMPTY_COL, id ?? '');
  const fromStore = useEditorStore((s) =>
    id ? s.composeLayers.find((l) => l.id === id) : undefined
  );
  if (!id) return undefined;
  return (fromMesh as unknown as ComposeLayerRecord | undefined) ?? fromStore;
}

/** Stand-in for the window before the peer is up. Hooks must be called
 *  unconditionally, and `observe` returning a no-op unsubscribe means nothing
 *  is registered against it. */
const EMPTY_COL = {
  rtype: '_none',
  get: () => undefined,
  observe: () => () => {},
} as unknown as Collection<Dto>;
