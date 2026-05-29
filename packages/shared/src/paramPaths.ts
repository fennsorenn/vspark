/**
 * Registry of paramPaths that can be addressed for runtime mutation.
 *
 * Consumed by:
 *   - Track-clip lane validation (only Float paths are animatable).
 *   - The `set_*_param` signal-graph nodes — to validate the path and resolve
 *     the expected value type at fire time.
 *   - The runtime-overrides bus — to coerce / route incoming values.
 *
 * This is the single source of truth. When adding a new animatable or
 * graph-mutatable parameter, register it here and the rest of the system
 * (clip evaluator, set_*_param nodes, override bus) follows.
 *
 * Paths use dotted form (e.g. "position.x", "text.content"). A path may be
 * applicable only to a subset of node/layer kinds — see `kinds`.
 */

export type ParamTargetKind = 'scene_node' | 'compose_layer';
export type ParamValueType = 'Float' | 'String' | 'Bool';

export interface ParamPathSpec {
  /** Conceptual dotted path used in lanes, set-param calls, and override keys. */
  path: string;
  /** Scalar type carried over the wire. */
  type: ParamValueType;
  /** Default value when neither override nor stored value is present. */
  defaultValue: number | string | boolean;
  /** If true, eligible for track-clip lane targeting (only Float). */
  animatable: boolean;
  /**
   * Node/layer kinds this path applies to. Empty = applies to all kinds of
   * the given target kind.
   */
  kinds?: readonly string[];
}

const SCENE_NODE_PARAM_PATHS: readonly ParamPathSpec[] = [
  // Transform: existing animatable scalars.
  { path: 'position.x', type: 'Float', defaultValue: 0, animatable: true },
  { path: 'position.y', type: 'Float', defaultValue: 0, animatable: true },
  { path: 'position.z', type: 'Float', defaultValue: 0, animatable: true },
  { path: 'rotation.x', type: 'Float', defaultValue: 0, animatable: true },
  { path: 'rotation.y', type: 'Float', defaultValue: 0, animatable: true },
  { path: 'rotation.z', type: 'Float', defaultValue: 0, animatable: true },
  { path: 'scale.x', type: 'Float', defaultValue: 1, animatable: true },
  { path: 'scale.y', type: 'Float', defaultValue: 1, animatable: true },
  { path: 'scale.z', type: 'Float', defaultValue: 1, animatable: true },
  // New: uniform mesh opacity walked across descendant materials.
  { path: 'opacity', type: 'Float', defaultValue: 1, animatable: true },
  // New: text content for the text scene-node kinds.
  {
    path: 'text.content',
    type: 'String',
    defaultValue: '',
    animatable: false,
    kinds: ['text_troika', 'text_canvas'],
  },
] as const;

const COMPOSE_LAYER_PARAM_PATHS: readonly ParamPathSpec[] = [
  // Layout: existing animatable scalars.
  { path: 'x', type: 'Float', defaultValue: 0, animatable: true },
  { path: 'y', type: 'Float', defaultValue: 0, animatable: true },
  { path: 'rotation', type: 'Float', defaultValue: 0, animatable: true },
  // New: dimension overrides + opacity (opacity was already in config; now first-class).
  { path: 'width', type: 'Float', defaultValue: 100, animatable: true },
  { path: 'height', type: 'Float', defaultValue: 100, animatable: true },
  { path: 'opacity', type: 'Float', defaultValue: 1, animatable: true },
  // New: text content for the text compose-layer kind.
  {
    path: 'text.content',
    type: 'String',
    defaultValue: '',
    animatable: false,
    kinds: ['text'],
  },
] as const;

const REGISTRY: Record<ParamTargetKind, ReadonlyMap<string, ParamPathSpec>> = {
  scene_node: new Map(SCENE_NODE_PARAM_PATHS.map((s) => [s.path, s])),
  compose_layer: new Map(COMPOSE_LAYER_PARAM_PATHS.map((s) => [s.path, s])),
};

/** Look up a paramPath spec. Returns undefined if the path is not registered
 *  for the given target kind. */
export function getParamPathSpec(
  targetKind: ParamTargetKind,
  paramPath: string
): ParamPathSpec | undefined {
  return REGISTRY[targetKind].get(paramPath);
}

/** Convenience: is this path valid for the given target kind, and (optionally)
 *  for the given node/layer kind? */
export function isParamPathValid(
  targetKind: ParamTargetKind,
  paramPath: string,
  entityKind?: string
): boolean {
  const spec = getParamPathSpec(targetKind, paramPath);
  if (!spec) return false;
  if (spec.kinds && entityKind != null && !spec.kinds.includes(entityKind))
    return false;
  return true;
}

/** All paths that may be used as track-clip lanes (Float + animatable). */
export function listAnimatableParamPaths(
  targetKind: ParamTargetKind
): readonly ParamPathSpec[] {
  const out: ParamPathSpec[] = [];
  for (const spec of REGISTRY[targetKind].values()) {
    if (spec.animatable && spec.type === 'Float') out.push(spec);
  }
  return out;
}

/** All registered paths for a target kind (irrespective of animatability). */
export function listAllParamPaths(
  targetKind: ParamTargetKind
): readonly ParamPathSpec[] {
  return Array.from(REGISTRY[targetKind].values());
}

/** Coerce an arbitrary JS value to the path's declared scalar type.
 *  Returns null when coercion is impossible (caller decides whether to log /
 *  reject the fire). */
export function coerceParamValue(
  spec: ParamPathSpec,
  value: unknown
): number | string | boolean | null {
  switch (spec.type) {
    case 'Float': {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
      }
      if (typeof value === 'boolean') return value ? 1 : 0;
      return null;
    }
    case 'String': {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
      return null;
    }
    case 'Bool': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      if (typeof value === 'string')
        return value === 'true' || value === '1' || value === 'yes';
      return null;
    }
  }
}
