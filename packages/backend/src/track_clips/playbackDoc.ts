/**
 * Server-side transport writes for a track clip.
 *
 * These are what the five REST endpoints call. The endpoints stay — `/api` is a
 * public surface for outside services (principle 5 in dev-notes/modules/mesh.md)
 * — but they no longer drive an in-memory playhead or broadcast their own WS
 * kinds. They write the `clip_playback` collection exactly as a tab would, and
 * persistence plus fan-out fall out of the mesh write.
 *
 * The arithmetic is deliberately the SAME module the frontend uses
 * (`@vspark/shared/clipPlayback`): a second copy of it here would drift from the
 * evaluator's silently, and the symptom — a clip that jumps a little on resume,
 * only when the seek came from HTTP — is not one anybody would trace back.
 */
import {
  anchorFor,
  playbackDocId,
  playheadAt,
  type ClipPlaybackDoc,
} from '@vspark/shared/clipPlayback';
import { getMeshCollection } from '../mesh/index.js';
import { getDb } from '../db/index.js';

/** Transport is a view action, not a document edit — never undoable. */
const OPTS = { undo: false } as const;

const col = () => getMeshCollection('clip_playback');

export function playbackOf(clipId: string): ClipPlaybackDoc | undefined {
  return col()?.get(playbackDocId(clipId)) as ClipPlaybackDoc | undefined;
}

/** Whether the clip exists at all — the routes 404 on a bad id rather than
 *  writing a playback document for something that cannot be played. */
export function clipExists(clipId: string): boolean {
  return !!getDb()
    .prepare('SELECT 1 FROM track_clips WHERE id = ?')
    .get(clipId);
}

function put(clipId: string, patch: Partial<ClipPlaybackDoc>): boolean {
  const c = col();
  if (!c) return false;
  const cur = playbackOf(clipId);
  const doc: ClipPlaybackDoc = {
    id: playbackDocId(clipId),
    clipId,
    state: 'stopped',
    startEpoch: null,
    pausedAtT: null,
    speed: cur?.speed ?? 1,
    loop: cur?.loop ?? false,
    ...cur,
    ...patch,
  };
  c.set(doc.id, '', doc, OPTS);
  return true;
}

export const triggerClip = (clipId: string, loop?: boolean): boolean =>
  put(clipId, {
    state: 'playing',
    startEpoch: Date.now(),
    pausedAtT: null,
    ...(loop === undefined ? {} : { loop }),
  });

export const stopClip = (clipId: string): boolean =>
  put(clipId, { state: 'stopped', startEpoch: null, pausedAtT: null });

export const pauseClip = (clipId: string): boolean =>
  put(clipId, {
    state: 'paused',
    pausedAtT: playheadAt(playbackOf(clipId)) ?? 0,
    startEpoch: null,
  });

export function resumeClip(clipId: string): boolean {
  const cur = playbackOf(clipId);
  return put(clipId, {
    state: 'playing',
    startEpoch: anchorFor(cur?.pausedAtT ?? 0, cur?.speed ?? 1),
    pausedAtT: null,
  });
}

export function seekClip(clipId: string, t: number): boolean {
  const cur = playbackOf(clipId);
  return cur?.state === 'playing'
    ? put(clipId, { startEpoch: anchorFor(t, cur.speed) })
    : put(clipId, { state: 'paused', pausedAtT: t, startEpoch: null });
}
