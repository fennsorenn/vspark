/**
 * Applying an in-flight node gesture from the mesh `preview` channel.
 *
 * Two feeders need this and must agree on it: {@link ./meshStoreFeeder} for
 * nodes of the open project, and {@link ./meshProjection} for the nodes of a
 * placed object projected from a peer. Same overlays, same tween — the only
 * difference is which set of nodes each one cares about.
 *
 * An ephemeral op IS a gesture by construction: that is what the lossy channel
 * carries, so it tweens rather than snapping. Retained ops are model state and
 * apply directly, elsewhere.
 */
import { smoothNodeTransform } from '../previewSmoother';

/** Node transforms are nested inside `components`, unlike a compose layer's
 *  flat x/y/width/height — so a preview path is `components.transform.<field>`. */
export const TRANSFORM_PREFIX = 'components.transform.';

/** Tweened as a single quaternion, so these three cannot be fed in one at a
 *  time — see the rotation note below. */
const ROTATION_FIELDS = new Set(['rx', 'ry', 'rz']);

/** The transform component's numeric fields, or undefined if the node has none. */
export function transformFieldsOf(node: {
  components?: unknown;
}): Record<string, number> | undefined {
  return (node.components as Record<string, unknown> | undefined)?.transform as
    | Record<string, number>
    | undefined;
}

/** Feed one ephemeral scene_node op into the tween for `nodeId`.
 *
 *  `doc` is the COMPOSED document — the retained doc with the in-flight
 *  overlays applied — and `path` is the single path this op touched. */
export function applyNodePreview(
  nodeId: string,
  doc: { components?: unknown },
  path: string | undefined
): void {
  const t = transformFieldsOf(doc);
  if (!t) return;
  // Previews are written one overlay PER SCALAR PATH, so read back just the
  // field this op touched rather than re-tweening every axis toward a value
  // that never changed. A pathless op (shouldn't happen) falls back to the
  // whole transform.
  const field = path?.startsWith(TRANSFORM_PREFIX)
    ? path.slice(TRANSFORM_PREFIX.length)
    : null;
  if (!field) {
    smoothNodeTransform(nodeId, t);
    return;
  }
  // Rotation is the exception: it tweens as ONE quaternion, and
  // smoothNodeTransform rebuilds the whole target from any axis it is not
  // given — reading those out of the store, which lags the running tween.
  // Feeding it the axes one at a time therefore lets the last op cancel the
  // ones before it (an rz:0 arriving after ry:90 recomputes the target as
  // (0,0,0) and the node never turns). `t` is the composed doc, so all three
  // axes there already carry the in-flight overlays.
  if (ROTATION_FIELDS.has(field)) {
    smoothNodeTransform(nodeId, { rx: t.rx, ry: t.ry, rz: t.rz });
    return;
  }
  smoothNodeTransform(nodeId, { [field]: t[field] });
}
