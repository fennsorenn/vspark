export interface BehaviorKindMeta {
  kind: string;
  label: string;
  icon: string;
  description: string;
  /** Node kinds this can be added to. Empty array or ['any'] = unrestricted. */
  applicableTo: string[];
  defaultConfig: Record<string, unknown>;
}

const _registry: BehaviorKindMeta[] = [];

export function BehaviorKind(meta: BehaviorKindMeta) {
  return function (_cls: object, _ctx: ClassDecoratorContext): void {
    _registry.push(meta);
  };
}

export function getAllBehaviorKindMeta(): BehaviorKindMeta[] {
  return _registry;
}
