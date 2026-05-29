import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
  Event,
  SignalTypeMap,
} from '@vspark/shared/signal';
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
export class SetComposeLayerParam {
  static readonly kind = 'set_compose_layer_param';
  static readonly inputPorts = [
    eventPort('fire', 'Trigger'),
    /** Optional alternative trigger: a SpawnRef event from spawn_clip. Its
     *  tmpNodeId overrides targetId for that fire. */
    eventPort('spawnRef', 'SpawnRef'),
    valuePort('targetId', 'EntityId'),
    valuePort('paramPath', 'String'),
    valuePort('value', 'Any'),
    valuePort('persist', 'Bool'),
  ] as const;
  static readonly outputPorts = [] as const;

  static execute(
    inputs: InputsOf<typeof SetComposeLayerParam>,
    config: SetComposeLayerParamConfig,
    ctx: NodeExecutionContext
  ): OutputsOf<typeof SetComposeLayerParam> {
    const empty = {} as OutputsOf<typeof SetComposeLayerParam>;
    if (ctx.triggeredPort !== 'fire' && ctx.triggeredPort !== 'spawnRef')
      return empty;

    let targetId =
      (inputs.targetId as string | undefined) || config.targetId;
    if (ctx.triggeredPort === 'spawnRef') {
      const ev = inputs.spawnRef as Event<SignalTypeMap['SpawnRef']> | undefined;
      const ref = ev?.payload;
      if (!ref) return empty;
      if (ref.kind !== 'compose_layer') {
        console.warn(
          `[set_compose_layer_param] ignoring spawnRef of kind ${ref.kind}`
        );
        return empty;
      }
      targetId = ref.tmpNodeId;
    }

    const paramPath =
      (inputs.paramPath as string | undefined) || config.paramPath;
    if (!targetId || !paramPath) return empty;
    const persist =
      (inputs.persist as boolean | undefined) ?? config.persist ?? false;
    runtimeOverrideManager.set(
      'compose_layer',
      targetId,
      paramPath,
      inputs.value,
      { persist }
    );
    return empty;
  }
}
