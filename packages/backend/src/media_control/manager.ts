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
 * past one-shots) and no SQLite. That is why commands ride the mesh CONTROL
 * channel — reliable but unstamped and UNRETAINED — rather than the retained
 * `runtime` channel the override and data-field buses use. See mesh/runtime.ts.
 *
 * It used to broadcast on `/ws` and be relayed a second time to collab peers
 * through `runtime_control`. One publish now reaches both: the command is
 * parented to its target, so it rides the same subtree grants everything else
 * on that entity does.
 *
 * See dev-notes/modules/media.md.
 */
import { CONTROL_CHANNEL, mediaControlCollection } from '../mesh/runtime.js';
import type { MediaCommand, MediaTargetKind } from '@vspark/shared';

export class MediaControlManager {
  /** Dispatch a media command to every peer holding the target. No-op without
   *  a target, or before the mesh is up. */
  dispatch(
    targetKind: MediaTargetKind,
    targetId: string,
    command: MediaCommand
  ): void {
    if (!targetId) return;
    mediaControlCollection()?.set(
      targetId,
      '',
      { id: targetId, targetKind, targetId, command },
      { channel: CONTROL_CHANNEL }
    );
  }
}

export const mediaControlManager = new MediaControlManager();
