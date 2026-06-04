import { SignalNode } from '@vspark/shared/signal';
import type { Event, SignalTypeMap } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { runtimeOverrideManager } from '../../runtime_overrides/manager.js';

interface SetSceneNodeParamConfig {
  targetId?: string;
  paramPath?: string;
  persist?: boolean;
}

/**
 * Writes a runtime override for a scene node param. The paramPath is validated
 * against the shared registry (see packages/shared/src/paramPaths.ts) and the
 * value is coerced to the path's declared scalar type at the bus boundary.
 *
 * In Phase 1 the `value` input is typed as `Any`; Phase 2 inference will
 * replace it with the registry-derived type. When `persist` is true, the bus
 * additionally writes through to SQLite via the manager's persist hook (a
 * no-op placeholder until that hook lands in a follow-up).
 *
 * The optional `spawnRef` event input lets `spawn_clip` retarget this call:
 * when a SpawnRef event arrives, its `tmpNodeId` overrides `targetId` for that
 * fire. Wired in Phase 1.6.
 */
@SignalNode({
  label: 'Set Scene Node Param',
  description:
    'Writes a runtime override for a scene-node param (e.g. position.x, opacity).',
  tags: ['scene', 'output'],
  color: '#3a7a5a',
})
export class SetSceneNodeParam extends Node {
  static readonly kind = 'set_scene_node_param';

  @valueIn('targetId', 'SceneNode') targetId!: () => string | undefined;
  @valueIn('paramPath', 'String') paramPath!: () => string | undefined;
  @valueIn('value', 'Any') value!: () => unknown;
  @valueIn('persist', 'Bool') persist!: () => boolean | undefined;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    this._write(undefined);
  }

  /** Alternative trigger: a SpawnRef event from spawn_clip retargets the write
   *  to the spawned instance (its `tmpNodeId`) for this fire. */
  @eventIn('spawnRef', 'SpawnRef')
  onSpawnRef(ev: Event<SignalTypeMap['SpawnRef']>): void {
    const ref = ev?.payload;
    if (!ref) return;
    if (ref.kind !== 'scene_node') {
      console.warn(
        `[set_scene_node_param] ignoring spawnRef of kind ${ref.kind}`
      );
      return;
    }
    this._write(ref.tmpNodeId);
  }

  private _write(retargetId: string | undefined): void {
    const cfg = (this.config ?? {}) as SetSceneNodeParamConfig;
    const targetId = retargetId ?? (this.targetId() || cfg.targetId);
    const paramPath = this.paramPath() || cfg.paramPath;
    if (!targetId || !paramPath) return;
    const persist = this.persist() ?? cfg.persist ?? false;
    runtimeOverrideManager.set(
      'scene_node',
      targetId,
      paramPath,
      this.value(),
      {
        persist,
      }
    );
  }
}
