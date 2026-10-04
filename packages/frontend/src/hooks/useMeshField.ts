/**
 * Bind one control to one field of a mesh document.
 *
 * The value reads live out of the mesh-fed store and writes back to the mesh, so
 * a bound control behaves like a reactive variable that happens to live in the
 * mesh: no local draft state to declare, no `useEffect` to re-sync it, no
 * explicit save call.
 *
 *   const name = useMeshField<string>(node.id, 'name', '');
 *   <input {...name.bind()} />
 *
 * What the hook owns, so no call site has to:
 *
 *  - **Commit granularity.** Every committed mesh write is one undo step, so
 *    typing must not commit per keystroke. `onChange` previews (local, free),
 *    `onBlur` commits once. Controls with their own gesture split (SliderInput's
 *    `onChange` / `onCommit`) map onto {@link MeshField.preview} / {@link
 *    MeshField.commit} directly; discrete controls (checkbox, select) use
 *    {@link MeshField.set}, which does both at once.
 *  - **Not clobbering an edit in progress.** While the user is mid-edit the
 *    draft wins, so a concurrent write from another tab can't yank the text out
 *    from under them. Outside an edit the field tracks the store live — which
 *    the older `useState` + `useEffect(…, [node.id])` pattern did not do: it
 *    re-synced only on selection change, leaving the input stale.
 *  - **Display fidelity.** The draft holds exactly what was typed, so
 *    intermediate states ('1.', '-') survive until commit instead of being
 *    round-tripped through a parse.
 *
 * Reads go through a zustand selector, so `path` must address a leaf (a scalar).
 * Selecting an object would return a fresh reference each render and re-render
 * forever.
 *
 * Hook rules apply: call it unconditionally, at a fixed position in render
 * order. Rows rendered conditionally or in a loop should call the imperative
 * {@link ../mesh/writes} helpers instead.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getPath } from '@vspark/mesh';
import { useEditorStore, type EditorState } from '../store/editorStore';
import { commitNodePath, previewNodePath, readNodePath } from '../mesh/writes';
import {
  useCollection,
  useMeshField as useDocumentField,
  type MeshField as DocumentField,
} from '@vspark/mesh-react';

export interface MeshField<T> {
  /** Current value: the in-flight draft while editing, else the stored value. */
  value: T;
  /** Live, uncommitted change (no undo entry). */
  preview: (v: T) => void;
  /** Commit — one undo step. Omit `v` to commit the current draft. */
  commit: (v?: T) => void;
  /** Preview + commit in one, for controls without a gesture (checkbox, select). */
  set: (v: T) => void;
  /** Spread onto an `<input>`: `{...field.bind()}`. */
  bind: () => {
    value: T;
    onChange: (e: { target: { value: string } }) => void;
    onBlur: () => void;
  };
}

export interface MeshFieldOptions<T> {
  /** Convert the raw input string for `bind()`. Defaults to identity (string);
   *  pass `Number` for numeric inputs. */
  parse?: (raw: string) => T;
  /** Show the in-progress edit to everyone while it's being typed (default).
   *  Turn off for values that are expensive or broken half-typed — a browser
   *  layer's URL would reload the page on every keystroke, a feed template
   *  would fail to compile — so only the draft changes until commit. */
  livePreview?: boolean;
}

/** How one kind of mesh document is read and written from a bound control. */
interface FieldBinding {
  select: (s: EditorState, id: string) => object | undefined;
  read: (id: string, path: string) => unknown;
  preview: (id: string, path: string, v: unknown) => void;
  commit: (id: string, path: string, v: unknown) => void;
}

const NODE_FIELDS: FieldBinding = {
  select: (s, id) => s.nodes.find((n) => n.id === id),
  read: readNodePath,
  preview: previewNodePath,
  commit: commitNodePath,
};

/** Bind a control to one field of a scene node. */
export function useMeshField<T>(
  nodeId: string,
  path: string,
  fallback: T,
  opts: MeshFieldOptions<T> = {}
): MeshField<T> {
  return useDocField(NODE_FIELDS, nodeId, path, fallback, opts);
}

/** Bind a control to one field of a compose layer (or compose scene). */
export function useLayerField<T>(
  layerId: string,
  path: string,
  fallback: T,
  opts: MeshFieldOptions<T> = {}
): MeshField<T> {
  return useDocumentField(
    useCollection('compose_layer'),
    layerId,
    path,
    fallback,
    opts
  ) as DocumentField<T>;
}

function useDocField<T>(
  b: FieldBinding,
  id: string,
  path: string,
  fallback: T,
  opts: MeshFieldOptions<T>
): MeshField<T> {
  const live = opts.livePreview !== false;
  const stored = useEditorStore(
    (s) => getPath(b.select(s, id), path) as T | undefined
  );
  const [draft, setDraft] = useState<{ v: T } | null>(null);
  // The value this gesture started from. `preview` applies to the store so the
  // viewport tracks the drag, which means by commit time the *stored* value has
  // already caught up with the draft — comparing against it would read every
  // edit as a no-op and silently drop the write. Non-null = gesture in flight.
  const gesture = useRef<{ base: T | undefined } | null>(null);

  // A draft belongs to the field it was typed into; drop it if the binding is
  // repointed (selection change) so the new field never shows the old text.
  useEffect(() => {
    setDraft(null);
    gesture.current = null;
  }, [id, path]);

  const value = draft ? draft.v : (stored ?? fallback);

  const preview = useCallback(
    (v: T) => {
      if (!gesture.current)
        gesture.current = { base: b.read(id, path) as T | undefined };
      setDraft({ v });
      if (live) b.preview(id, path, v);
    },
    [b, id, path, live]
  );

  const commit = useCallback(
    (v?: T) => {
      const g = gesture.current;
      gesture.current = null;
      const next = v !== undefined ? v : draft?.v;
      setDraft(null);
      if (next === undefined) return;
      if (next === (g ? g.base : stored)) return; // genuinely unchanged
      b.commit(id, path, next);
    },
    [b, id, path, draft, stored]
  );

  const set = useCallback(
    (v: T) => {
      if (live) b.preview(id, path, v);
      commit(v);
    },
    [b, id, path, live, commit]
  );

  const bind = useCallback(
    () => ({
      value,
      onChange: (e: { target: { value: string } }) =>
        preview(
          (opts.parse ?? ((raw: string) => raw as unknown as T))(e.target.value)
        ),
      onBlur: () => commit(),
    }),
    [value, preview, commit, opts.parse]
  );

  return { value, preview, commit, set, bind };
}
