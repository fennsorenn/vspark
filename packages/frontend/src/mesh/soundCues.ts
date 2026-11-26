/**
 * One-shot sounds (`sound_cue` documents on the `control` channel): a graph's
 * Play Sound node — or an Action's "Play sound" response — plays a collection
 * sound in every tab of the project that may play audio, with no entity in the
 * scene. Like media commands these are events, not state: the collection keeps
 * nothing, so a tab that connects later never replays an old sound.
 *
 * Mounted by the viewer page (always audible) and the editor (audible only with
 * audio preview on) — the same audibility gate as video and audio entities.
 */
import { useEffect, useRef } from 'react';
import { useMesh } from '@vspark/mesh-react';
import type { SoundCue } from '@vspark/shared/types';
import { useEditorStore } from '../store/editorStore';

/** The URL of a collection asset, or null when this tab doesn't know it. */
export function assetUrl(assetId: string): string | null {
  return (
    useEditorStore.getState().assets.find((a) => a.id === assetId)?.url ?? null
  );
}

/** Play one cue (exported for tests). */
export function playSoundCue(cue: SoundCue): HTMLAudioElement | null {
  const url = assetUrl(cue.assetId);
  if (!url) return null;
  const el = new Audio(url);
  el.volume =
    typeof cue.volume === 'number' ? Math.max(0, Math.min(1, cue.volume)) : 1;
  void el.play().catch(() => {
    /* autoplay may be blocked until a user gesture; nothing to retry */
  });
  return el;
}

/** Play the project's sound cues while `audible`. */
export function useSoundCues(
  projectId: string | null | undefined,
  audible: boolean
): void {
  const peer = useMesh();
  const audibleRef = useRef(audible);
  audibleRef.current = audible;
  useEffect(() => {
    if (!projectId) return;
    return peer.collection<SoundCue>('sound_cue').observe('**', (c) => {
      if (c.op === 'remove' || !c.doc || c.doc.projectId !== projectId) return;
      if (audibleRef.current) playSoundCue(c.doc);
    });
  }, [peer, projectId]);
}
