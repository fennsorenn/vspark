/**
 * Transport writes for a track clip, authored on the tab's own mesh peer.
 *
 * These replace the five REST endpoints (trigger / stop / pause / resume /
 * seek) that drove a backend-authoritative playhead and broadcast
 * `track_clip_started` / `_paused` / `_stopped` over /ws. The document IS the
 * transport state; every peer derives its own playhead from it.
 *
 * **Decided: none of these are undoable.** Transport is a view action, not a
 * document edit — without `undo: false`, pressing Play would make the next
 * Ctrl+Z un-pause rather than undo the user's last real edit. Scrub-release
 * carries the same flag. See principle-adjacent notes in
 * dev-notes/modules/mesh.md (Undo / redo → Opting out).
 */
import { getMeshHandles } from './peer';
import { anchorFor, playbackDocId, playheadAt } from '../clipPlayhead';
import { useEditorStore, type ClipPlayback } from '../store/editorStore';

/** Transport never lands on the undo stack. */
const OPTS = { undo: false } as const;

const col = () => getMeshHandles()?.collections.clip_playback;

/** Current transport state for a clip, from this tab's replica. */
export const playbackOf = (clipId: string): ClipPlayback | undefined =>
  useEditorStore.getState().clipPlayback[clipId];

/** Whole-document write. Playback docs are small and always written as a unit —
 *  a partial would leave the anchor and the state disagreeing between ops. */
function put(clipId: string, patch: Partial<ClipPlayback>): void {
  const c = col();
  if (!c?.canWrite()) return;
  const cur = playbackOf(clipId);
  const doc: ClipPlayback = {
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
}

/** Start from the beginning. */
export function commitPlay(clipId: string, loop = false): void {
  put(clipId, {
    state: 'playing',
    startEpoch: Date.now(),
    pausedAtT: null,
    loop,
  });
}

/** Freeze at the current playhead. */
export function commitPause(clipId: string): void {
  const cur = playbackOf(clipId);
  put(clipId, {
    state: 'paused',
    pausedAtT: playheadAt(cur) ?? 0,
    startEpoch: null,
  });
}

/** Continue from where the pause froze it, re-anchoring to now. */
export function commitResume(clipId: string): void {
  const cur = playbackOf(clipId);
  put(clipId, {
    state: 'playing',
    startEpoch: anchorFor(cur?.pausedAtT ?? 0, cur?.speed ?? 1),
    pausedAtT: null,
  });
}

export function commitStop(clipId: string): void {
  put(clipId, { state: 'stopped', startEpoch: null, pausedAtT: null });
}

/** Move the playhead to `t`, keeping whatever the clip was doing. Playing keeps
 *  playing from there (re-anchored); paused or stopped freezes at `t`. */
export function commitSeek(clipId: string, t: number): void {
  const cur = playbackOf(clipId);
  if (cur?.state === 'playing')
    put(clipId, { startEpoch: anchorFor(t, cur.speed) });
  else put(clipId, { state: 'paused', pausedAtT: t, startEpoch: null });
}

/** In-flight scrub, on the lossy `preview` channel: other peers follow the drag
 *  without it becoming model state, and nothing persists until release.
 *
 *  One overlay PER FIELD — a pathless ephemeral write is a root overlay that
 *  replaces the composed doc wholesale, losing the id along with everything
 *  else. Falls back to a local apply when the peer cannot author, so the
 *  scrubbing tab still tracks its own drag. */
export function previewSeek(clipId: string, t: number): void {
  const c = col();
  const id = playbackDocId(clipId);
  const fields = { state: 'paused', pausedAtT: t, startEpoch: null };
  if (c?.canWrite() && c.get(id)) {
    for (const [field, value] of Object.entries(fields))
      c.set(id, field, value, { channel: 'preview' });
    return;
  }
  const cur = playbackOf(clipId);
  if (cur)
    useEditorStore
      .getState()
      .upsertClipPlayback({ ...cur, ...fields } as ClipPlayback);
}
