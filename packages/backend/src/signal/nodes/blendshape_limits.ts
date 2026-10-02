import { SignalNode, Blendshapes } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';
import {
  applyBlendshapeLimits,
  normalizeBlendshapeLimits,
} from '@vspark/shared/blendshapeLimits';

/**
 * Applies expression-limit rules to a blendshape frame: exclusive groups (only
 * the strongest of a set of competing expressions survives) followed by clamp
 * rules (a driver expression caps the range of a set of target shapes).
 *
 * The rule engine itself is the pure `applyBlendshapeLimits` in
 * `@vspark/shared/blendshapeLimits`; this node is only the graph wrapper. The
 * `limits` input is wired in from a `behavior_config` (Behavior Settings) node
 * reading the behavior's `limits` field, so the config is visible on the graph
 * rather than read behind the node's back — and because node config resolves
 * live per access, UI edits hot-apply without a graph rebuild.
 *
 * Designed to sit inside a blendshape interceptor chain: wire `blendshapes`
 * from an `on_blendshapes_broadcast` node and the output into a
 * `blendshapes_interceptor_broadcast`.
 */
@SignalNode({
  label: 'Expression Limits',
  description:
    'Keeps expressions from stacking into broken faces: exclusive groups suppress competing expressions, clamp rules cap target shapes while a driver expression is active.',
  tags: ['calibration'],
  color: '#9f4a7a',
})
export class BlendshapeLimits extends Node {
  static readonly kind = 'blendshape_limits';

  @valueIn('blendshapes', 'Blendshapes')
  blendshapesIn!: () => Blendshapes | undefined;
  // The rule set, wired in from a `behavior_config` node reading the behavior's
  // `limits` field. Read live on each pull so UI edits apply immediately.
  @valueIn('limits', 'Any') limitsIn!: () => unknown;

  @valueOut('blendshapes', 'Blendshapes')
  blendshapes = (): Blendshapes | undefined => {
    const input = this.blendshapesIn();
    if (!input) return undefined;

    const config = normalizeBlendshapeLimits(this.limitsIn());
    if (
      config.enabled === false ||
      ((config.groups?.length ?? 0) === 0 && (config.clamps?.length ?? 0) === 0)
    )
      return input;

    return Blendshapes.fromRecord(
      applyBlendshapeLimits(input.toRecord(), config)
    );
  };
}
