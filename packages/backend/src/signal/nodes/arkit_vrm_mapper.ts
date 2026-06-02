import { SignalNode, Blendshapes } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';
import { ARKIT_SHAPES, ARKIT_TO_VRM, ARKIT_TO_FCL } from '@vspark/shared/arkit';

export { ARKIT_SHAPES, ARKIT_TO_VRM, ARKIT_TO_FCL };
export type ArkitShape = (typeof ARKIT_SHAPES)[number];

export type ArkitMapperMode = 'expressions' | 'fcl' | 'passthrough';

export interface ArkitVrmMapperConfig {
  mode?: ArkitMapperMode;
}

// ──────────────────────────────────────────────────────────────────────────────
// Node
// ──────────────────────────────────────────────────────────────────────────────

@SignalNode({
  label: 'ARKit → VRM Mapper',
  description:
    'Maps raw ARKit 52-shape weights to VRM expression names, or passes them through unchanged for direct morph-target driving.',
  tags: ['mapping', 'face'],
  color: '#5a3a2a',
})
export class ArkitVrmMapper extends Node {
  static readonly kind = 'arkit_vrm_mapper';

  @valueIn('arkit', 'ArkitBlendshapes') arkit!: () => Blendshapes | undefined;
  @valueIn('enabled', 'Bool') enabledIn!: () => boolean | undefined;
  @valueIn('mapping', 'MappingTable') mapping!: () =>
    | Record<string, [string, number][]>
    | null
    | undefined;

  @valueOut('blendshapes', 'Blendshapes')
  blendshapes = (): Blendshapes => {
    if (this.enabledIn() === false) {
      return Blendshapes.fromRecord({});
    }

    const arkit = this.arkit();
    if (!arkit) return Blendshapes.fromRecord({});

    const config = (this.config ?? {}) as ArkitVrmMapperConfig;
    const mode = config.mode ?? 'expressions';
    const customMapping = this.mapping();

    const builtinTable: Partial<Record<string, [string, number][]>> =
      mode === 'fcl'
        ? ARKIT_TO_FCL
        : mode === 'expressions'
          ? ARKIT_TO_VRM
          : {};
    const effectiveTable = customMapping
      ? { ...builtinTable, ...customMapping }
      : builtinTable;

    if (mode === 'passthrough' && !customMapping) return arkit;

    const accum: Record<string, number> = {};
    for (const [arkitName, weight] of arkit.entries()) {
      const mappings = effectiveTable[arkitName];
      if (mode === 'passthrough' && !mappings) {
        accum[arkitName] = (accum[arkitName] ?? 0) + weight;
        continue;
      }
      if (!mappings) continue;
      for (const [target, scale] of mappings)
        accum[target] = (accum[target] ?? 0) + weight * scale;
    }
    const clamped: Record<string, number> = {};
    for (const [k, v] of Object.entries(accum))
      clamped[k] = Math.min(1, Math.max(0, v));
    return Blendshapes.fromRecord(clamped);
  };
}
