/**
 * Clip lifecycle on the backend: spotting a finished clip, and starting the
 * autoplay ones at boot.
 *
 * This is what replaces `TrackClipPlaybackManager`. The manager owned the
 * playhead in memory and scheduled a `setTimeout` per clip to stop it; there is
 * nothing to own any more, because the playhead is derived from the
 * `clip_playback` document. So finishing is derived too: read the documents this
 * server already holds, compute each playhead, and stop the ones that have run
 * past their duration.
 *
 * Only NON-LOOPING clips can finish. A looping clip's playhead wraps forever,
 * which is why the old manager only ever armed a timer for non-looping ones.
 *
 * The one thing a document cannot supply is the duration of a clip that has no
 * row — SpawnManager plays in-memory clones that were never persisted — so
 * those register their duration here when they start.
 */
import {
  playbackDocId,
  playheadAt,
  type ClipPlaybackDoc,
} from '@vspark/shared/clipPlayback';
import { getDb } from '../db/index.js';
import { getMeshCollection } from '../mesh/index.js';
import { stopClip, triggerClip } from './playbackDoc.js';

export type ClipFinishedListener = (clipId: string) => void;

const listeners = new Set<ClipFinishedListener>();
/** clipId → duration, for clips with no `track_clips` row (spawned clones). */
const ephemeralDurations = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;

/** Notified when a clip's playback ends. Returns an unsubscribe function. */
export function onClipFinished(fn: ClipFinishedListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Register the duration of a clip that exists only in memory. */
export function setEphemeralDuration(clipId: string, duration: number): void {
  ephemeralDurations.set(clipId, duration);
}

export function clearEphemeralDuration(clipId: string): void {
  ephemeralDurations.delete(clipId);
}

/** Duration in seconds, or undefined if this server knows of no such clip. */
function durationOf(clipId: string): number | undefined {
  const ephemeral = ephemeralDurations.get(clipId);
  if (ephemeral !== undefined) return ephemeral;
  const row = getDb()
    .prepare('SELECT duration FROM track_clips WHERE id = ?')
    .get(clipId) as { duration: number } | undefined;
  return row?.duration;
}

/**
 * The clips whose playhead has run past their duration.
 *
 * Pure over its inputs so the rule can be tested without a clock, a database or
 * a mesh peer — the arithmetic is the same `playheadAt` every peer uses, which
 * is the point: a clip finishes at the moment the evaluator stops finding
 * anything to drive, not at whatever moment a timer happens to fire.
 */
export function finishedClips(
  docs: ClipPlaybackDoc[],
  duration: (clipId: string) => number | undefined,
  now = Date.now()
): string[] {
  const out: string[] = [];
  for (const d of docs) {
    if (d.state !== 'playing' || d.loop) continue;
    const dur = duration(d.clipId);
    if (dur === undefined || dur <= 0) continue;
    const t = playheadAt(d, now);
    if (t !== null && t >= dur) out.push(d.clipId);
  }
  return out;
}

/** One pass: stop everything that has finished and tell the listeners. */
export function sweepFinished(now = Date.now()): string[] {
  const col = getMeshCollection('clip_playback');
  if (!col) return [];
  const done = finishedClips(
    col.all() as unknown as ClipPlaybackDoc[],
    durationOf,
    now
  );
  for (const clipId of done) {
    stopClip(clipId);
    for (const fn of listeners) fn(clipId);
  }
  return done;
}

/**
 * Start the autoplay clips.
 *
 * A clip that was already playing when the process stopped needs nothing: its
 * document persisted, anchor included, so it resumes IN PHASE — that is the
 * whole reason the collection is persisted rather than replicate-only. This only
 * has to start the ones that are not playing.
 */
export function startAutoplayClips(): void {
  const col = getMeshCollection('clip_playback');
  if (!col) return;
  const rows = getDb()
    .prepare('SELECT id, loop FROM track_clips WHERE autoplay = 1 AND loop = 1')
    .all() as { id: string; loop: number }[];
  for (const r of rows) {
    const doc = col.get(playbackDocId(r.id)) as unknown as
      | ClipPlaybackDoc
      | undefined;
    if (doc?.state === 'playing' && doc.startEpoch != null) continue;
    triggerClip(r.id, true);
  }
}

/** Sweep on an interval. 250ms is well inside a frame budget's tolerance for
 *  "the clip stopped": the evaluator already stops driving at `duration`, so
 *  this only governs how promptly the document catches up and dependents
 *  (spawn teardown) run. */
export function startClipLifecycle(intervalMs = 250): void {
  stopClipLifecycle();
  startAutoplayClips();
  timer = setInterval(() => sweepFinished(), intervalMs);
  timer.unref?.();
}

export function stopClipLifecycle(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seam: drop all listeners and ephemeral registrations. */
export function resetClipLifecycle(): void {
  stopClipLifecycle();
  listeners.clear();
  ephemeralDurations.clear();
}
