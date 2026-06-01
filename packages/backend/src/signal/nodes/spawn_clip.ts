import {
  SignalNode,
  eventPort,
  valuePort,
  mkEvent,
} from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
} from '@vspark/shared/signal';
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
  tags: ['clips', 'spawn', 'output'],
  color: '#c97a3a',
})
export class SpawnClip {
  static readonly kind = 'spawn_clip';
  static readonly inputPorts = [
    eventPort('fire', 'Trigger'),
    valuePort('clipId', 'String'),
  ] as const;
  static readonly outputPorts = [eventPort('spawned', 'SpawnRef')] as const;

  static execute(
    inputs: InputsOf<typeof SpawnClip>,
    config: SpawnClipConfig,
    ctx: NodeExecutionContext
  ): OutputsOf<typeof SpawnClip> {
    if (ctx.triggeredPort !== 'fire')
      return {} as OutputsOf<typeof SpawnClip>;
    const clipId = (inputs.clipId as string | undefined) || config.clipId;
    if (!clipId) return {} as OutputsOf<typeof SpawnClip>;
    const ref = spawnManager.spawn(clipId);
    if (!ref) return {} as OutputsOf<typeof SpawnClip>;
    return { spawned: mkEvent(ref) } as OutputsOf<typeof SpawnClip>;
  }
}
