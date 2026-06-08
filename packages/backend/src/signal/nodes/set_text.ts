import { SignalNode } from '@vspark/shared/signal';
import type { Event, SignalTypeMap } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { runtimeOverrideManager } from '../../runtime_overrides/manager.js';
import type { ParamTargetKind } from '@vspark/shared/paramPaths';

interface SetTextConfig {
  targetKind?: ParamTargetKind;
  targetId?: string;
  persist?: boolean;
}

/**
 * Convenience over set_*_param hardcoded to the `text.content` paramPath.
 * Accepts either kind via the `targetKind` config (defaults to 'scene_node').
 */
@SignalNode({
  label: 'Set Text',
  description:
    "Writes a runtime override on the target's text.content paramPath.",
  tags: ["scene"],
  color: '#3a7a5a',
})
export class SetText extends Node {
  static readonly kind = 'set_text';

  @valueIn('targetId', 'SceneEntity') targetId!: () => string | undefined;
  @valueIn('targetKind', 'String') targetKind!: () => string | undefined;
  @valueIn('text', 'String') text!: () => string | undefined;
  @valueIn('persist', 'Bool') persist!: () => boolean | undefined;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    this._write(undefined);
  }

  /** Alternative trigger: a SpawnRef event from spawn_clip retargets the write
   *  to the spawned instance — its `tmpNodeId` + `kind` override targetId /
   *  targetKind for this fire. */
  @eventIn('spawnRef', 'SpawnRef')
  onSpawnRef(ev: Event<SignalTypeMap['SpawnRef']>): void {
    const ref = ev?.payload;
    if (!ref) return;
    this._write(ref);
  }

  private _write(ref: SignalTypeMap['SpawnRef'] | undefined): void {
    const cfg = (this.config ?? {}) as SetTextConfig;
    let targetId = this.targetId() || cfg.targetId;
    let targetKind: ParamTargetKind = (() => {
      const raw = this.targetKind() ?? cfg.targetKind ?? 'scene_node';
      return raw === 'compose_layer' ? 'compose_layer' : 'scene_node';
    })();
    if (ref) {
      targetId = ref.tmpNodeId;
      targetKind = ref.kind;
    }
    if (!targetId) return;
    const text = this.text() ?? '';
    const persist = this.persist() ?? cfg.persist ?? false;
    runtimeOverrideManager.set(targetKind, targetId, 'text.content', text, {
      persist,
    });
  }
}
