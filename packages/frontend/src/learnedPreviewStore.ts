/**
 * Learned Tracking camera preview frames (backend
 * behaviors/learned_tracker/preview.ts), arriving over /ws as
 * `learned_preview_frame` and handed to the open preview windows. Not kept in
 * React state: a window draws each frame straight onto its canvas.
 */

export interface LearnedPreviewFrame {
  behaviorId: string;
  t: number;
  width: number;
  height: number;
  mirrored: boolean;
  /** base64 JPEG, when the window asked for the picture. */
  image?: string;
  /** Normalized image coordinates (0..1, x right, y down) of the mirrored
   *  frame; pose rows are [x, y, visibility], the others [x, y]. Streams not
   *  detected in this frame are missing. */
  landmarks?: Partial<
    Record<'pose' | 'leftHand' | 'rightHand' | 'face', number[][]>
  >;
}

type Listener = (f: LearnedPreviewFrame) => void;
const listeners = new Set<Listener>();

export function onLearnedPreview(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitLearnedPreview(f: LearnedPreviewFrame): void {
  for (const fn of listeners) fn(f);
}
