/**
 * Deriving a clip's playhead from its synced transport state.
 *
 * Nothing streams the playhead. Every peer holds the clip document and its
 * `clip_playback` document and computes the same number from the same inputs —
 * principle 1 in dev-notes/modules/mesh.md. These are the pure functions that
 * derivation is made of, kept apart from both the evaluator (which runs them 60
 * times a second) and the write helpers (which run them in reverse to re-anchor).
 */
import type { ClipPlayback } from './store/editorStore';

/** The doc id for a clip's playback state.
 *
 *  DERIVED, not minted. Two tabs pressing Play on a never-played clip would
 *  otherwise each mint a uuid, producing two documents for one clip — both
 *  replicate, and the second trips the UNIQUE(clip_id) constraint on persist.
 *  A deterministic id makes that concurrent create a plain LWW race on one
 *  document, which is what the mesh is for. It stays distinct from the clip's
 *  own id because the containment index keys by id across every rtype. */
export const playbackDocId = (clipId: string): string => `pb:${clipId}`;

/** Seconds into the clip right now, given its transport state.
 *
 *  Playing: elapsed wall time since the anchor, scaled by speed. Paused: the
 *  frozen value. Stopped (or never played): null — the caller should drive
 *  nothing at all rather than hold the clip at zero. */
export function playheadAt(
  pb: ClipPlayback | undefined,
  now = Date.now()
): number | null {
  if (!pb || pb.state === 'stopped') return null;
  if (pb.state === 'paused') return pb.pausedAtT ?? 0;
  if (pb.startEpoch == null) return null;
  return ((now - pb.startEpoch) * (pb.speed || 1)) / 1000;
}

/** The `startEpoch` that puts the playhead at `t` seconds right now.
 *
 *  The inverse of {@link playheadAt}, used whenever playback has to keep running
 *  from a new position — resuming from a pause, or a scrub released while
 *  playing. Re-anchoring rather than storing an offset keeps the forward
 *  derivation a single subtraction, with no accumulated drift. */
export function anchorFor(t: number, speed = 1, now = Date.now()): number {
  return Math.round(now - (t * 1000) / (speed || 1));
}
