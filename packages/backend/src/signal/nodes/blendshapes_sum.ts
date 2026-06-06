import { SignalNode, Blendshapes } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { listIn, valueOut } from '@vspark/shared/node_decorators';

/**
 * Additively merges any number of Blendshapes sources (clamped to [0,1]).
 * The `sources` list port accepts multiple incoming value connections — each
 * connected mapper feeds into the same port and all contributions are summed.
 */
@SignalNode({
  label: 'Combine Blendshapes',
  description:
    'Additively merges blendshape sources. Connect any number of mapper outputs to the sources list port.',
  tags: ['mapping', 'face'],
  color: '#5a4a2a',
})
export class BlendshapesSum extends Node {
  static readonly kind = 'blendshapes_sum';

  @listIn('sources', 'Blendshapes') sources!: () => Blendshapes[];

  @valueOut('blendshapes', 'Blendshapes')
  blendshapes = (): Blendshapes => {
    const accum: Record<string, number> = {};
    for (const bs of this.sources()) {
      for (const [name, val] of bs.entries()) {
        accum[name as string] = Math.min(1, (accum[name as string] ?? 0) + val);
      }
    }
    return Blendshapes.fromRecord(accum);
  };
}
