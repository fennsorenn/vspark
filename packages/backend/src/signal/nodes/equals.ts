import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';

/**
 * Pure comparison: `equal` is true when `a` and `b` hold the same value.
 * Primitives compare strictly (`'1'` is not `1`, text is case-sensitive);
 * arrays and plain objects compare structurally, field by field. Two unset
 * inputs are equal.
 */
@SignalNode({
  label: 'Equals',
  description:
    'Outputs true when both inputs hold the same value. Text comparison is case-sensitive; numbers and text never equal each other.',
  tags: ['utility'],
  color: '#3a5a6a',
})
export class Equals extends Node {
  static readonly kind = 'equals';

  @valueIn('a', 'Any') a!: () => unknown;
  @valueIn('b', 'Any') b!: () => unknown;

  @valueOut('equal', 'Bool') equal = (): boolean =>
    deepEqual(this.a() ?? null, this.b() ?? null);
}

export function deepEqual(x: unknown, y: unknown): boolean {
  if (Object.is(x, y)) return true;
  if (typeof x !== 'object' || typeof y !== 'object' || !x || !y) return false;
  if (Array.isArray(x) !== Array.isArray(y)) return false;
  if (Array.isArray(x)) {
    const ya = y as unknown[];
    return x.length === ya.length && x.every((v, i) => deepEqual(v, ya[i]));
  }
  const xo = x as Record<string, unknown>;
  const yo = y as Record<string, unknown>;
  const keys = Object.keys(xo);
  if (keys.length !== Object.keys(yo).length) return false;
  return keys.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(yo, k) && deepEqual(xo[k], yo[k])
  );
}
