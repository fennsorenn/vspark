import { SignalNode } from '@vspark/shared/signal';
import type { Event, SignalTypeMap } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import type { MediaAction, MediaTargetKind } from '@vspark/shared';
import { mediaControlManager } from '../../media_control/manager.js';

interface MediaControlConfig {
  action?: MediaAction;
  targetKind?: MediaTargetKind;
  targetId?: string;
}

/**
 * Fires a fire-and-forget media command (play / pause / stop / restart / seek /
 * setVolume / mute / unmute) at a video or audio entity through the
 * media-control bus. The target is a scene-node or compose-layer id — taken
 * from the wired `target` input when present, else `config.targetId`. The
 * frontend media registry is keyed by id alone, so `targetKind` is informational.
 *
 * `t` feeds `seek`; `volume` feeds `setVolume`. A `spawnRef` event from
 * `spawn_clip` retargets the command to the spawned instance for that fire.
 */
@SignalNode({
  label: 'Media Control',
  description:
    'Play / pause / stop / seek a video or audio entity (fire-and-forget).',
  tags: ["output"],
  color: '#7a3a6a',
})
export class MediaControl extends Node {
  static readonly kind = 'media_control';

  @valueIn('target', 'SceneEntity') target!: () => string | undefined;
  @valueIn('t', 'Float') t!: () => number | undefined;
  @valueIn('volume', 'Float') volume!: () => number | undefined;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    this._dispatch(undefined);
  }

  /** A SpawnRef event from spawn_clip retargets the command to the spawned
   *  instance (its tmp id) for this fire. */
  @eventIn('spawnRef', 'SpawnRef')
  onSpawnRef(ev: Event<SignalTypeMap['SpawnRef']>): void {
    const ref = ev?.payload;
    if (!ref) return;
    this._dispatch(ref.tmpNodeId);
  }

  private _dispatch(retargetId: string | undefined): void {
    const cfg = (this.config ?? {}) as MediaControlConfig;
    const targetId = retargetId ?? (this.target() || cfg.targetId);
    if (!targetId) return;
    const action: MediaAction = cfg.action ?? 'play';
    const targetKind: MediaTargetKind = cfg.targetKind ?? 'scene_node';
    const t = this.t();
    const volume = this.volume();
    mediaControlManager.dispatch(targetKind, targetId, {
      action,
      ...(typeof t === 'number' ? { t } : {}),
      ...(typeof volume === 'number' ? { volume } : {}),
    });
  }
}
