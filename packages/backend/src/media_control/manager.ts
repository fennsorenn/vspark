/**
 * Media-control bus.
 *
 * A fire-and-forget command channel parallel to the runtime-override and
 * data-channel buses. Where those carry *state* (held scalar values re-applied
 * each frame), this carries *commands* — play / pause / stop / restart / seek /
 * setVolume / mute — which the scalar buses can't express. Signal-graph nodes
 * (and the track-clip event lane, client-side) dispatch through here; the
 * frontend media registry applies the command to the live <video>/<audio>
 * element.
 *
 * Stateless by design: no snapshot on connect (a late joiner shouldn't replay
 * past one-shots) and no SQLite.
 *
 * See dev-notes/modules/media.md.
 */
import type { WSSync } from '../ws/index.js';
import type { MediaCommand, MediaTargetKind } from '@vspark/shared';

export class MediaControlManager {
  private _ws: WSSync | null = null;

  init(ws: WSSync): void {
    this._ws = ws;
  }

  /** Broadcast a media command to all clients. No-op without a target. */
  dispatch(
    targetKind: MediaTargetKind,
    targetId: string,
    command: MediaCommand
  ): void {
    if (!targetId) return;
    this._ws?.broadcast('media_control', { targetKind, targetId, command });
  }
}

export const mediaControlManager = new MediaControlManager();
