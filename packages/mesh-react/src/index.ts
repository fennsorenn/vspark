/**
 * @vspark/mesh-react — React bindings for the mesh store.
 *
 * Thin hooks over `useSyncExternalStore`. Snapshots are referentially stable
 * between changes (the replica caches composed reads; selector hooks cache
 * derived arrays), so components re-render exactly when the selected data
 * changes. Writes go straight to the collection — "bind a value, write a
 * value" with no store-mirroring plumbing.
 *
 * An app provides its peer once (`<MeshProvider peer={peer}>`); components then
 * reach any collection by name (`useCollection('scene_node')`) and bind fields
 * to documents (`useMeshField`).
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
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
export function useMeshValue<
  V = unknown,
  T extends object = Record<string, unknown>,
>(
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

// --- the peer as the app's store ------------------------------------------------

const MeshContext = createContext<MeshPeer | null>(null);

/** Provide the app's peer to every hook below. */
export function MeshProvider(props: {
  peer: MeshPeer;
  children?: ReactNode;
}): ReturnType<typeof createElement> {
  return createElement(
    MeshContext.Provider,
    { value: props.peer },
    props.children
  );
}

/** The provided peer. */
export function useMesh(): MeshPeer {
  const peer = useContext(MeshContext);
  if (!peer)
    throw new Error('mesh-react: no <MeshProvider> above this component');
  return peer;
}

/** A collection of the provided peer, by name. */
export function useCollection<T extends object = Record<string, unknown>>(
  rtype: string
): Collection<T> {
  return useMesh().collection<T>(rtype);
}

/** Whether a committed write to `col` can be decided right now (its authority
 *  is reachable). Re-renders on connectivity changes. */
export function useMeshCanWrite<T extends object>(col: Collection<T>): boolean {
  useMeshStatus(useMesh());
  return col.canWrite();
}

// --- binding a control to a field ------------------------------------------------

export interface MeshField<V> {
  /** Current value: the in-flight draft while editing, else the document's. */
  value: V;
  /** Live, uncommitted change: a preview everyone sees, no undo entry. */
  preview: (v: V) => void;
  /** Commit — one undo step. Omit `v` to commit the current draft. */
  commit: (v?: V) => void;
  /** Preview + commit in one, for controls without a gesture (checkbox, select). */
  set: (v: V) => void;
  /** Spread onto an `<input>`: `{...field.bind()}`. */
  bind: () => {
    value: V;
    onChange: (e: { target: { value: string } }) => void;
    onBlur: () => void;
  };
}

export interface MeshFieldOptions<V> {
  /** Convert the raw input string for `bind()`. Defaults to identity (string);
   *  pass `Number` for numeric inputs. */
  parse?: (raw: string) => V;
  /** Show the in-progress edit to everyone while it's being typed (default).
   *  Turn off for values that are expensive or broken half-typed, so only the
   *  draft changes until commit. */
  livePreview?: boolean;
  /** Minimum ms between previews sent while editing (default 33 — about 30
   *  per second). The control shows every change at once regardless; the
   *  commit carries the final value. */
  previewIntervalMs?: number;
}

/**
 * Bind one control to one field of one document.
 *
 *   const name = useMeshField(nodes, node.id, 'name', '');
 *   <input {...name.bind()} />
 *
 * Typing previews (the `preview` channel: everyone sees it, nothing is
 * persisted or logged); blur commits once — one undo step. While the user is
 * mid-edit the draft wins, so a concurrent edit from another peer can't yank
 * the text out from under them; outside an edit the field tracks the document
 * live. The draft holds exactly what was typed, so intermediate states ('1.',
 * '-') survive until commit.
 */
export function useMeshField<V, T extends object = Record<string, unknown>>(
  col: Collection<T>,
  id: string,
  path: string,
  fallback: V,
  opts: MeshFieldOptions<V> = {}
): MeshField<V> {
  const live = opts.livePreview !== false;
  const stored = useMeshSelector(
    col,
    id,
    (c) => getPath(c.get(id), path) as V | undefined
  );
  const [draft, setDraft] = useState<{ v: V } | null>(null);
  // The committed value this gesture started from. A live preview overlays
  // the document, so by commit time the *read* value has caught up with the
  // draft — comparing against it would drop every edit as a no-op.
  const gesture = useRef<{ base: V | undefined } | null>(null);
  const lastPreviewAt = useRef(0);
  const interval = opts.previewIntervalMs ?? 33;

  // A draft belongs to the field it was typed into.
  useEffect(() => {
    setDraft(null);
    gesture.current = null;
  }, [col, id, path]);

  const committed = useCallback(
    () => getPath(col.replica.raw(id), path) as V | undefined,
    [col, id, path]
  );

  const preview = useCallback(
    (v: V) => {
      if (!gesture.current) gesture.current = { base: committed() };
      setDraft({ v });
      if (!live || !col.get(id)) return;
      const now = Date.now();
      if (now - lastPreviewAt.current < interval) return;
      lastPreviewAt.current = now;
      col.set(id, path, v, { channel: 'preview' });
    },
    [col, id, path, live, committed, interval]
  );

  const commit = useCallback(
    (v?: V) => {
      const g = gesture.current;
      gesture.current = null;
      const next = v !== undefined ? v : draft?.v;
      setDraft(null);
      if (next === undefined) return;
      if (next === (g ? g.base : committed())) return; // genuinely unchanged
      if (col.get(id)) col.set(id, path, next);
    },
    [col, id, path, draft, committed]
  );

  const set = useCallback((v: V) => commit(v), [commit]);

  const bind = useCallback(
    () => ({
      value: draft ? draft.v : (stored ?? fallback),
      onChange: (e: { target: { value: string } }) =>
        preview(
          (opts.parse ?? ((raw: string) => raw as unknown as V))(e.target.value)
        ),
      onBlur: () => commit(),
    }),
    [draft, stored, fallback, preview, commit, opts.parse]
  );

  return {
    value: draft ? draft.v : (stored ?? fallback),
    preview,
    commit,
    set,
    bind,
  };
}
