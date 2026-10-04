/**
 * Bind one control to one field of a mesh document.
 *
 * The value reads live out of the replica and writes back to the mesh, so a
 * bound control behaves like a reactive variable that happens to live in the
 * mesh: no local draft state to declare, no `useEffect` to re-sync it, no
 * explicit save call. Both are the generic `@vspark/mesh-react` binding, on
 * the scene_node and compose_layer collections.
 *
 *   const name = useMeshField<string>(node.id, 'name', '');
 *   <input {...name.bind()} />
 *
 * What the hook owns, so no call site has to:
 *
 *  - **Commit granularity.** Every committed mesh write is one undo step, so
 *    typing must not commit per keystroke. `onChange` previews (the `preview`
 *    channel: everyone sees it, nothing persists), `onBlur` commits once. Controls with their own gesture split (SliderInput's
 *    `onChange` / `onCommit`) map onto {@link MeshField.preview} / {@link
 *    MeshField.commit} directly; discrete controls (checkbox, select) use
 *    {@link MeshField.set}, which does both at once.
 *  - **Not clobbering an edit in progress.** While the user is mid-edit the
 *    draft wins, so a concurrent write from another tab can't yank the text out
 *    from under them. Outside an edit the field tracks the document live — which
 *    the older `useState` + `useEffect(…, [node.id])` pattern did not do: it
 *    re-synced only on selection change, leaving the input stale.
 *  - **Display fidelity.** The draft holds exactly what was typed, so
 *    intermediate states ('1.', '-') survive until commit instead of being
 *    round-tripped through a parse.
 *
 * Hook rules apply: call it unconditionally, at a fixed position in render
 * order. Rows rendered conditionally or in a loop should call the imperative
 * write helpers (mesh/writes.ts, mesh/docs.ts) instead.
 */
import {
  useCollection,
  useMeshField as useDocumentField,
  type MeshField,
  type MeshFieldOptions,
} from '@vspark/mesh-react';

export type { MeshField, MeshFieldOptions };

/** Bind a control to one field of a scene node. */
export function useMeshField<T>(
  nodeId: string,
  path: string,
  fallback: T,
  opts: MeshFieldOptions<T> = {}
): MeshField<T> {
  return useDocumentField(
    useCollection('scene_node'),
    nodeId,
    path,
    fallback,
    opts
  ) as MeshField<T>;
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
  ) as MeshField<T>;
}
