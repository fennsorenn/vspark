/**
 * transformMerge.test.ts — a gesture writes only the fields it drives.
 *
 * Every gesture commit site replaces `components.transform` wholesale, so a
 * field missing from the committed object is a field deleted from the document.
 * A transform component carries more than the nine numbers a drag produces:
 * `getTransform` (Viewport.tsx) also reads opacity, castShadow and receiveShadow
 * off it and defaults them to 1 / true / true. Before this helper existed, that
 * combination silently reset a node at opacity 0.3 to fully opaque on every
 * gizmo drag end.
 */
import { describe, it, expect } from 'vitest';
import { mergedTransform } from '../src/components/editor/transformMerge';

/** The nine numbers a drag actually produces. */
const GESTURE = {
  x: 1,
  y: 2,
  z: 3,
  rx: 0,
  ry: 0,
  rz: 0,
  sx: 1,
  sy: 1,
  sz: 1,
};

/** A node whose transform carries non-default values for exactly the fields no
 *  gesture drives — the regression case. */
const nodeWithExtras = {
  components: {
    transform: {
      type: 'transform',
      x: 0,
      y: 0,
      z: 0,
      opacity: 0.3,
      castShadow: false,
      receiveShadow: false,
    },
  },
};

describe('mergedTransform', () => {
  it('preserves fields the gesture does not drive', () => {
    const out = mergedTransform(nodeWithExtras, GESTURE);
    expect(out.opacity).toBe(0.3);
    expect(out.castShadow).toBe(false);
    expect(out.receiveShadow).toBe(false);
  });

  it('applies the gesture over the stored values', () => {
    const out = mergedTransform(nodeWithExtras, GESTURE);
    expect(out.x).toBe(1);
    expect(out.y).toBe(2);
    expect(out.z).toBe(3);
  });

  it('keeps the component discriminant', () => {
    expect(mergedTransform(nodeWithExtras, GESTURE).type).toBe('transform');
    expect(mergedTransform(undefined, GESTURE).type).toBe('transform');
  });

  it('carries through fields added after this was written', () => {
    // The helper must not enumerate a field list, or every future transform
    // field silently regains this bug.
    const node = {
      components: { transform: { type: 'transform', someLaterField: 'keep' } },
    };
    expect(mergedTransform(node, GESTURE).someLaterField).toBe('keep');
  });

  it('handles a node with no stored transform', () => {
    expect(mergedTransform({ components: {} }, GESTURE)).toEqual({
      type: 'transform',
      ...GESTURE,
    });
    expect(mergedTransform(undefined, GESTURE)).toEqual({
      type: 'transform',
      ...GESTURE,
    });
  });

  it('does not mutate the stored component', () => {
    const before = JSON.stringify(nodeWithExtras);
    mergedTransform(nodeWithExtras, GESTURE);
    expect(JSON.stringify(nodeWithExtras)).toBe(before);
  });
});
