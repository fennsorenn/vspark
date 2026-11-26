import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { mediaControlManager } from '../../media_control/manager.js';

interface PlaySoundConfig {
  assetId?: string;
  volume?: number;
  /** Injected by LogicManager: the project the sound plays in. */
  _projectId?: unknown;
}

/**
 * Plays a sound from the project's collection once, without an audio entity in
 * the scene: every tab of the project that may play audio (a viewer, or the
 * editor with audio preview on) plays it. Fire-and-forget; see
 * `MediaControlManager.playSound` and dev-notes/modules/media.md.
 *
 * `assetId` / `volume` (0..1, default 1) fall back to config when unwired.
 */
@SignalNode({
  label: 'Play Sound',
  description:
    'Plays a sound from the collection once, without placing an audio entity.',
  tags: ['output'],
  color: '#7a3a6a',
})
export class PlaySound extends Node {
  static readonly kind = 'play_sound';

  @valueIn('assetId', 'String') assetId!: () => string | undefined;
  @valueIn('volume', 'Float') volume!: () => number | undefined;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const cfg = (this.config ?? {}) as PlaySoundConfig;
    const projectId = cfg._projectId;
    if (typeof projectId !== 'string' || projectId === '') return;
    const assetId = this.assetId() || cfg.assetId;
    if (!assetId) return;
    const v = this.volume();
    const volume = typeof v === 'number' ? v : cfg.volume;
    mediaControlManager.playSound(projectId, assetId, volume);
  }
}
