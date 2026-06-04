import { SignalNode } from '@vspark/shared/signal';
import type { Event, SignalTypeMap } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { runtimeOverrideManager } from '../../runtime_overrides/manager.js';

interface SetComposeLayerParamConfig {
  targetId?: string;
  paramPath?: string;
  persist?: boolean;
}

/** Compose-layer counterpart to set_scene_node_param. */
@SignalNode({
  label: 'Set Compose Layer Param',
  description:
    'Writes a runtime override for a compose-layer param (e.g. x, opacity, width).',
  tags: ['compose', 'output'],
  color: '#3a7a5a',
})
export class SetComposeLayerParam extends Node {
  static readonly kind = 'set_compose_layer_param';

  @valueIn('targetId', 'ComposeLayer') targetId!: () => string | undefined;
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
    if (ref.kind !== 'compose_layer') {
      console.warn(
        `[set_compose_layer_param] ignoring spawnRef of kind ${ref.kind}`
      );
      return;
    }
    this._write(ref.tmpNodeId);
  }

  private _write(retargetId: string | undefined): void {
    const cfg = (this.config ?? {}) as SetComposeLayerParamConfig;
    const targetId = retargetId ?? (this.targetId() || cfg.targetId);
    const paramPath = this.paramPath() || cfg.paramPath;
    if (!targetId || !paramPath) return;
    const persist = this.persist() ?? cfg.persist ?? false;
    runtimeOverrideManager.set(
      'compose_layer',
      targetId,
      paramPath,
      this.value(),
      { persist }
    );
  }
}
