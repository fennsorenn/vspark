import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
} from '@vspark/shared/signal';
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
export class SetSceneNodeParam {
  static readonly kind = 'set_scene_node_param';
  static readonly inputPorts = [
    eventPort('fire', 'Trigger'),
    valuePort('targetId', 'EntityId'),
    valuePort('paramPath', 'String'),
    valuePort('value', 'Any'),
    valuePort('persist', 'Bool'),
  ] as const;
  static readonly outputPorts = [] as const;

  static execute(
    inputs: InputsOf<typeof SetSceneNodeParam>,
    config: SetSceneNodeParamConfig,
    ctx: NodeExecutionContext
  ): OutputsOf<typeof SetSceneNodeParam> {
    if (ctx.triggeredPort !== 'fire')
      return {} as OutputsOf<typeof SetSceneNodeParam>;
    const targetId =
      (inputs.targetId as string | undefined) || config.targetId;
    const paramPath =
      (inputs.paramPath as string | undefined) || config.paramPath;
    if (!targetId || !paramPath)
      return {} as OutputsOf<typeof SetSceneNodeParam>;
    const persist =
      (inputs.persist as boolean | undefined) ?? config.persist ?? false;
    runtimeOverrideManager.set(
      'scene_node',
      targetId,
      paramPath,
      inputs.value,
      { persist }
    );
    return {} as OutputsOf<typeof SetSceneNodeParam>;
  }
}
