import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
  Event,
  SignalTypeMap,
} from '@vspark/shared/signal';
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
  tags: ['scene', 'compose', 'output'],
  color: '#3a7a5a',
})
export class SetText {
  static readonly kind = 'set_text';
  static readonly inputPorts = [
    eventPort('fire', 'Trigger'),
    /** Optional alternative trigger: a SpawnRef event from spawn_clip. Its
     *  tmpNodeId + kind override targetId / targetKind for that fire. */
    eventPort('spawnRef', 'SpawnRef'),
    valuePort('targetId', 'EntityId'),
    valuePort('targetKind', 'String'),
    valuePort('text', 'String'),
    valuePort('persist', 'Bool'),
  ] as const;
  static readonly outputPorts = [] as const;

  static execute(
    inputs: InputsOf<typeof SetText>,
    config: SetTextConfig,
    ctx: NodeExecutionContext
  ): OutputsOf<typeof SetText> {
    const empty = {} as OutputsOf<typeof SetText>;
    if (ctx.triggeredPort !== 'fire' && ctx.triggeredPort !== 'spawnRef')
      return empty;

    let targetId = (inputs.targetId as string | undefined) || config.targetId;
    let targetKind: ParamTargetKind = (() => {
      const raw =
        (inputs.targetKind as string | undefined) ??
        config.targetKind ??
        'scene_node';
      return raw === 'compose_layer' ? 'compose_layer' : 'scene_node';
    })();
    if (ctx.triggeredPort === 'spawnRef') {
      const ev = inputs.spawnRef as Event<SignalTypeMap['SpawnRef']> | undefined;
      const ref = ev?.payload;
      if (!ref) return empty;
      targetId = ref.tmpNodeId;
      targetKind = ref.kind;
    }
    if (!targetId) return empty;
    const text = (inputs.text as string | undefined) ?? '';
    const persist =
      (inputs.persist as boolean | undefined) ?? config.persist ?? false;
    runtimeOverrideManager.set(targetKind, targetId, 'text.content', text, {
      persist,
    });
    return empty;
  }
}
