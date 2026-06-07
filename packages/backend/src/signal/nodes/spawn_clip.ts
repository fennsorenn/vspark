import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, eventOut } from '@vspark/shared/node_decorators';
import type { SignalTypeMap } from '@vspark/shared/signal';
import { spawnManager } from '../../spawn/manager.js';

interface SpawnClipConfig {
  clipId?: string;
}

/**
 * Ephemeral clone-and-play.
 *
 * Looks up the clip's owner entity (scene node or compose layer), deep-clones
 * it with a tmp id, duplicates the clip with its lane targets remapped to the
 * tmp id, and starts playback. On clip completion the tmp entity + tmp clip
 * are cleaned up. Nothing touches SQLite.
 *
 * Emits a `spawned` event carrying the `SpawnRef` (tmpNodeId, tmpClipId, kind)
 * so downstream `set_*_param` nodes can address the spawned instance during
 * its lifetime.
 *
 * See dev-notes/modules/spawn.md.
 */
@SignalNode({
  label: 'Spawn Clip',
  description:
    'Clones the clip’s owner entity and plays a tmp copy of the clip on it. Cleans up on completion.',
  tags: ["clips"],
  color: '#c97a3a',
})
export class SpawnClip extends Node {
  static readonly kind = 'spawn_clip';

  @valueIn('clipId', 'String') clipId!: () => string | undefined;

  @eventOut('spawned', 'SpawnRef') spawned!: Emitter<SignalTypeMap['SpawnRef']>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const cfg = (this.config ?? {}) as SpawnClipConfig;
    const clipId = this.clipId() || cfg.clipId;
    if (!clipId) return;
    const ref = spawnManager.spawn(clipId);
    if (!ref) return;
    this.spawned.emit(ref);
  }
}
