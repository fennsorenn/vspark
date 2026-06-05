import type { MediaCommand } from '@vspark/shared';

/**
 * Imperative registry of live media elements (3D video nodes, compose-layer
 * `<video>`, audio scene nodes) keyed by their scene-node / compose-layer id.
 *
 * Media playback is command-oriented (play / pause / restart / seek), which the
 * scalar runtime-override and track-clip buses can't express — so commands are
 * delivered straight to the element through this module-level map rather than
 * through React state. Components register a handle on mount and unregister on
 * unmount; the media-command WS handler (useWsSync) and the track-clip event
 * lane (useTrackClipEvaluator) look the handle up and call it.
 */
export interface MediaHandle {
  play(): void;
  pause(): void;
  /** Stop and reset to the start (and, for a video node with onEnd:'hide', hide). */
  stop(): void;
  /** Seek to 0 and play. */
  restart(): void;
  /** Seek to `t` seconds. */
  seek(t: number): void;
  /** Set volume 0..1. */
  setVolume(v: number): void;
  mute(): void;
  unmute(): void;
}

const handles = new Map<string, MediaHandle>();

/** Register a media handle for `id`. Returns an unregister fn (safe to call in
 *  a React effect cleanup; only removes the handle if it's still the current one). */
export function registerMedia(id: string, handle: MediaHandle): () => void {
  handles.set(id, handle);
  return () => {
    if (handles.get(id) === handle) handles.delete(id);
  };
}

export function getMediaHandle(id: string): MediaHandle | undefined {
  return handles.get(id);
}

/** Apply a media command to the registered handle for `id`. No-op if absent
 *  (e.g. the entity isn't mounted / rendered on this client). */
export function dispatchMediaCommand(id: string, cmd: MediaCommand): void {
  const h = handles.get(id);
  if (!h) return;
  switch (cmd.action) {
    case 'play':
      h.play();
      break;
    case 'pause':
      h.pause();
      break;
    case 'stop':
      h.stop();
      break;
    case 'restart':
      h.restart();
      break;
    case 'seek':
      h.seek(cmd.t ?? 0);
      break;
    case 'setVolume':
      h.setVolume(cmd.volume ?? 1);
      break;
    case 'mute':
      h.mute();
      break;
    case 'unmute':
      h.unmute();
      break;
  }
}
