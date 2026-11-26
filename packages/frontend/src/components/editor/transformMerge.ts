/**
 * Merge a gesture's transform payload over a node's stored transform component.
 *
 * Every gesture commit site replaces `components.transform` **wholesale** — the
 * mesh write is `col.set(id, 'components.transform', value)`, a subtree replace,
 * not a merge. So any stored field missing from the object handed to it is
 * deleted from the document.
 *
 * That matters because a transform component carries more than the nine numbers
 * a drag produces. `getTransform` in Viewport.tsx reads `opacity`, `castShadow`
 * and `receiveShadow` out of the same object and defaults them to 1 / true /
 * true when absent — so committing a bare gesture payload silently resets a
 * node at opacity 0.3 to fully opaque on every drag end.
 *
 * The rule is narrow and worth stating: **a gesture writes only the fields it
 * drives.** Everything else on the component rides through untouched, including
 * fields added after this was written.
 */
export function mergedTransform(
  node: { components?: Record<string, unknown> } | undefined,
  payload: Record<string, number>
): Record<string, unknown> {
  const existing = node?.components?.transform as
    | Record<string, unknown>
    | undefined;
  return { ...existing, type: 'transform', ...payload };
}
