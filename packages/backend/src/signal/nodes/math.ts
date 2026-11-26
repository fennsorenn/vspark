import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';

/** A finite number, or null. Numeric strings count (literals typed into a
 *  handle may arrive as text). */
function numOf(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export const MATH_OPS = [
  'add',
  'subtract',
  'multiply',
  'divide',
  'min',
  'max',
] as const;
export type MathOp = (typeof MATH_OPS)[number];

/** Pure two-operand arithmetic. An unset operand counts as 0; dividing by 0
 *  gives 0 rather than Infinity, so a downstream variable never stores a
 *  non-JSON value. */
export function applyMath(op: unknown, a: number, b: number): number {
  switch (op) {
    case 'subtract':
      return a - b;
    case 'multiply':
      return a * b;
    case 'divide':
      return b === 0 ? 0 : a / b;
    case 'min':
      return Math.min(a, b);
    case 'max':
      return Math.max(a, b);
    default:
      return a + b;
  }
}

@SignalNode({
  label: 'Math',
  description:
    'Outputs a (op) b: add, subtract, multiply, divide, min or max. An unset input counts as 0; dividing by 0 gives 0.',
  tags: ['math'],
  color: '#4a7a5a',
})
export class MathNode extends Node {
  static readonly kind = 'math';

  @valueIn('a', 'Float') a!: () => unknown;
  @valueIn('b', 'Float') b!: () => unknown;
  /** One of MATH_OPS; anything else adds. */
  @valueIn('op', 'String') op!: () => unknown;

  @valueOut('value', 'Float') value = (): number =>
    applyMath(this.op(), numOf(this.a()) ?? 0, numOf(this.b()) ?? 0);
}

@SignalNode({
  label: 'Clamp',
  description:
    'Keeps a number between min and max. Leave a bound empty to leave that side open.',
  tags: ['math'],
  color: '#4a7a5a',
})
export class Clamp extends Node {
  static readonly kind = 'clamp';

  @valueIn('value', 'Float') input!: () => unknown;
  @valueIn('min', 'Float') min!: () => unknown;
  @valueIn('max', 'Float') max!: () => unknown;

  @valueOut('value', 'Float') value = (): number => {
    let v = numOf(this.input()) ?? 0;
    const lo = numOf(this.min());
    const hi = numOf(this.max());
    if (lo !== null) v = Math.max(lo, v);
    if (hi !== null) v = Math.min(hi, v);
    return v;
  };
}

export interface Step {
  /** Threshold: the step applies once the input reaches it. */
  at: number;
  value: number;
}

/** The steps as a sorted list of usable entries. Accepts the list itself or
 *  its JSON text. */
export function stepsOf(raw: unknown): Step[] {
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: Step[] = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const at = numOf((s as Record<string, unknown>).at);
    const value = numOf((s as Record<string, unknown>).value);
    if (at !== null && value !== null) out.push({ at, value });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The value of the highest step whose threshold `x` has reached, else
 *  `below`. */
export function lookupStep(steps: Step[], x: number, below: number): number {
  let v = below;
  for (const s of steps) {
    if (x >= s.at) v = s.value;
    else break;
  }
  return v;
}

@SignalNode({
  label: 'Step Lookup',
  description:
    'Picks a value by thresholds: the value of the highest step whose "at" the input has reached, or "below" before the first step. Steps are a list of { at, value }.',
  tags: ['math'],
  color: '#4a7a5a',
})
export class StepLookup extends Node {
  static readonly kind = 'step_lookup';

  @valueIn('x', 'Float') x!: () => unknown;
  /** `[{ at, value }, …]` (any order). */
  @valueIn('steps', 'Any') steps!: () => unknown;
  /** The value before the first threshold (default 1). */
  @valueIn('below', 'Float') below!: () => unknown;

  @valueOut('value', 'Float') value = (): number =>
    lookupStep(
      stepsOf(this.steps()),
      numOf(this.x()) ?? 0,
      numOf(this.below()) ?? 1
    );
}
