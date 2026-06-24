import { describe, expect, test } from 'vitest';
import { dropZoneFromEvent, type DropZone } from '../src/components/editor/dnd';

/**
 * Unit coverage for the shared tree drag-and-drop zone classifier used by both
 * the stage tree (SceneGraph) and the compose tree (ComposeTree): the cursor's
 * vertical position over a row decides whether the drop nests as a child
 * (`inside`) or positions as a sibling (`before` / `after`).
 */

/** Build a minimal React.DragEvent stand-in: a currentTarget whose
 *  getBoundingClientRect reports a 100px-tall row at top=0, and a cursor at
 *  `clientY`. */
function evAt(clientY: number, height = 100): React.DragEvent {
  return {
    clientY,
    currentTarget: {
      getBoundingClientRect: () => ({ top: 0, height }),
    },
  } as unknown as React.DragEvent;
}

describe('dropZoneFromEvent', () => {
  test('top band → before', () => {
    expect(dropZoneFromEvent(evAt(5))).toBe<DropZone>('before');
    expect(dropZoneFromEvent(evAt(27))).toBe<DropZone>('before');
  });

  test('middle band → inside', () => {
    expect(dropZoneFromEvent(evAt(29))).toBe<DropZone>('inside');
    expect(dropZoneFromEvent(evAt(50))).toBe<DropZone>('inside');
    expect(dropZoneFromEvent(evAt(71))).toBe<DropZone>('inside');
  });

  test('bottom band → after', () => {
    expect(dropZoneFromEvent(evAt(73))).toBe<DropZone>('after');
    expect(dropZoneFromEvent(evAt(99))).toBe<DropZone>('after');
  });

  test('allowInside=false collapses to a before/after split at the midpoint', () => {
    expect(dropZoneFromEvent(evAt(49), false)).toBe<DropZone>('before');
    expect(dropZoneFromEvent(evAt(51), false)).toBe<DropZone>('after');
    // even the deep-middle, which would be `inside` when nesting is allowed.
    expect(dropZoneFromEvent(evAt(50), false)).toBe<DropZone>('after');
  });

  test('degenerate zero-height row falls back to the inside band', () => {
    expect(dropZoneFromEvent(evAt(0, 0))).toBe<DropZone>('inside');
  });
});
