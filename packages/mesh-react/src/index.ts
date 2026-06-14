/**
 * @vspark/mesh-react — React bindings for the mesh store.
 *
 * Thin hooks over `useSyncExternalStore`. Snapshots are referentially stable
 * between changes (the replica caches composed reads; selector hooks cache
 * derived arrays), so components re-render exactly when the selected data
 * changes. Writes go straight to the collection — "bind a value, write a
 * value" with no store-mirroring plumbing.
 */
import { useCallback, useRef, useSyncExternalStore } from 'react';
import {
  getPath,
  type Collection,
  type MeshPeer,
  type MeshStatus,
  type Selector,
  type WriteHandle,
  type WriteOpts,
} from '@vspark/mesh';

function selKey(sel: Selector): string {
  if (sel === '**') return '**';
  return typeof sel === 'string' ? `id:${sel}` : `subtree:${sel.subtree}`;
}

/** Core helper: subscribe to a selector, recompute a derived value on change,
 *  serve it as a stable snapshot. `compute` must be pure over the collection. */
export function useMeshSelector<T extends object, R>(
  col: Collection<T>,
  sel: Selector,
  compute: (col: Collection<T>) => R
): R {
  const state = useRef<{ key: string; value: R } | null>(null);
  const key = `${col.rtype}|${selKey(sel)}`;
  if (state.current === null || state.current.key !== key)
    state.current = { key, value: compute(col) };
  const subscribe = useCallback(
    (onChange: () => void) =>
      col.observe(sel, () => {
        state.current = { key, value: compute(col) };
        onChange();
      }),
    // compute is pure over (col, sel) — both captured in key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [col, key]
  );
  const snapshot = () => state.current!.value;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** One document, overlay-aware; re-renders on any change to it. */
export function useMeshDoc<T extends object>(
  col: Collection<T>,
  id: string
): T | undefined {
  return useMeshSelector(col, id, (c) => c.get(id));
}

/** This collection's docs within the containment subtree under `rootId`. */
export function useMeshSubtree<T extends object>(
  col: Collection<T>,
  rootId: string
): T[] {
  return useMeshSelector(col, { subtree: rootId }, (c) => c.subtree(rootId));
}

/** Direct children of `id` in this collection. */
export function useMeshChildren<T extends object>(
  col: Collection<T>,
  id: string
): T[] {
  return useMeshSelector(col, { subtree: id }, (c) => c.children(id));
}

/** Every doc in the collection. */
export function useMeshAll<T extends object>(col: Collection<T>): T[] {
  return useMeshSelector(col, '**', (c) => c.all());
}

/** Bind one dotted-path value: `[value, setValue]`.
 *  `setValue(v)` writes the collection's retained channel;
 *  `setValue(v, { channel: 'preview' })` writes lossily while interacting —
 *  the landing committed write clears the preview overlay everywhere. */
export function useMeshValue<V = unknown, T extends object = Record<string, unknown>>(
  col: Collection<T>,
  id: string,
  path: string,
  defaults?: WriteOpts
): [V | undefined, (value: V, opts?: WriteOpts) => WriteHandle] {
  const value = useMeshSelector(
    col,
    id,
    (c) => getPath(c.get(id), path) as V | undefined
  );
  const setValue = useCallback(
    (v: V, opts?: WriteOpts) => col.set(id, path, v, opts ?? defaults),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [col, id, path, defaults?.channel]
  );
  return [value, setValue];
}

/** Live mesh status: connected peers + pending (unacked) writes. */
export function useMeshStatus(peer: MeshPeer): MeshStatus {
  const state = useRef<{ value: MeshStatus } | null>(null);
  if (state.current === null) state.current = { value: peer.status() };
  const subscribe = useCallback(
    (onChange: () => void) =>
      peer.onStatus((s) => {
        state.current = { value: s };
        onChange();
      }),
    [peer]
  );
  const snapshot = () => state.current!.value;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Whether guarded writes to this collection can currently succeed (its ack
 *  authority is reachable). Use to disable edit controls during outages. */
export function useCanWrite<T extends object>(
  peer: MeshPeer,
  col: Collection<T>
): boolean {
  useMeshStatus(peer); // re-render on connectivity changes
  return col.canWrite();
}
