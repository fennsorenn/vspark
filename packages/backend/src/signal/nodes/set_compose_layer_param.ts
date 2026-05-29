import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
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
    if (ctx.triggeredPort !== 'fire')
      return {} as OutputsOf<typeof SetComposeLayerParam>;
    const targetId =
      (inputs.targetId as string | undefined) || config.targetId;
    const paramPath =
      (inputs.paramPath as string | undefined) || config.paramPath;
    if (!targetId || !paramPath)
      return {} as OutputsOf<typeof SetComposeLayerParam>;
    const persist =
      (inputs.persist as boolean | undefined) ?? config.persist ?? false;
    runtimeOverrideManager.set(
      'compose_layer',
      targetId,
      paramPath,
      inputs.value,
      { persist }
    );
    return {} as OutputsOf<typeof SetComposeLayerParam>;
  }
}
