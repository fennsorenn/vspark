export interface ComponentKindMeta {
  kind: string;
  label: string;
  icon: string;
  description: string;
  /** Node kinds this can be added to. Empty array or ['any'] = unrestricted. */
  applicableTo: string[];
  defaultConfig: Record<string, unknown>;
}

const _registry: ComponentKindMeta[] = [];

export function ComponentKind(meta: ComponentKindMeta) {
  return function (_cls: object, _ctx: ClassDecoratorContext): void {
    _registry.push(meta);
  };
}

export function getAllComponentKindMeta(): ComponentKindMeta[] {
  return _registry;
}
