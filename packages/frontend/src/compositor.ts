/**
 * Effective-value compositor for the unified sync read-model.
 *
 * Folds an ordered layer stack (low → high) over a base value. Today every
 * layer is `replace` (highest present value wins), so this is a precedence
 * coalesce — `effective = top ?? … ?? base`. Add/multiply/weighted blends and
 * pose compositing layer on later (see dev-notes/plans/unified-sync-layer.md).
 *
 * This centralises the precedence rule that was duplicated in Viewport's
 * `useTransformWithOverride` and ComposeLayerStack's `layerStyle`. Behaviour is
 * identical to both: per field, track-clip override > runtime override > base.
 * (Applying the clip layer last means it wins, which matches the previous
 * "clip is the winner, runtime only fills what clip didn't" logic.)
 */

/** A layer's contribution: paramPath → value. Absent / non-number = no
 *  contribution for that field (matching the old `?? `/`undefined` checks). */
export type ScalarLayer = Record<string, number | undefined> | undefined;

/**
 * Fold replace-layers low → high over `base`. `base` seeds the output; each
 * layer's numeric fields overwrite. Non-number layer values are ignored (a
 * runtime-override map may carry string/bool values for non-scalar paths).
 */
export function compositeScalars(
  base: Record<string, number>,
  layers: ScalarLayer[]
): Record<string, number> {
  const out: Record<string, number> = { ...base };
  for (const layer of layers) {
    if (!layer) continue;
    for (const path in layer) {
      const v = layer[path];
      if (typeof v === 'number') out[path] = v;
    }
  }
  return out;
}
