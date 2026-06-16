import { describe, it, expect } from 'vitest';
import {
  eventIn,
  valueIn,
  listIn,
  eventOut,
  valueOut,
} from '../src/node_decorators.js';
import { PORT_BUFFER, type PortMeta } from '../src/node.js';

/**
 * The decorators are exercised by invoking them directly with a mock decorator
 * context (a plain object carrying `name` + a shared `metadata` buffer) — this
 * covers each decorator body without depending on the TS decorator transform.
 */
type Meta = Record<symbol, PortMeta[]>;
const buffered = (m: Meta): PortMeta[] => m[PORT_BUFFER] ?? [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fieldCtx = (name: string, metadata: Meta): any => ({
  kind: 'field',
  name,
  metadata,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const methodCtx = (name: string, metadata: Meta): any => ({
  kind: 'method',
  name,
  metadata,
});

describe('field decorators', () => {
  it('valueIn buffers a value/in port and returns an identity initializer', () => {
    const m: Meta = {};
    const init = valueIn('a', 'Float')(undefined, fieldCtx('aField', m));
    expect(buffered(m)).toEqual([
      {
        name: 'a',
        direction: 'in',
        transport: 'value',
        typeTag: 'Float',
        member: 'aField',
      },
    ]);
    expect(init.call(null, 42)).toBe(42);
  });

  it('listIn buffers a list/in port', () => {
    const m: Meta = {};
    listIn('xs', 'Float')(undefined, fieldCtx('xs', m));
    expect(buffered(m)[0]).toMatchObject({
      direction: 'in',
      transport: 'list',
    });
  });

  it('eventOut buffers an event/out port', () => {
    const m: Meta = {};
    const init = eventOut('out', 'String')(undefined, fieldCtx('out', m));
    expect(buffered(m)[0]).toMatchObject({
      direction: 'out',
      transport: 'event',
    });
    expect(init.call(null, 'x')).toBe('x');
  });

  it('valueOut buffers a value/out port', () => {
    const m: Meta = {};
    valueOut('p', 'Float')(undefined, fieldCtx('p', m));
    expect(buffered(m)[0]).toMatchObject({
      direction: 'out',
      transport: 'value',
    });
  });
});

describe('eventIn (method decorator)', () => {
  it('buffers an event/in port and returns the method unchanged', () => {
    const m: Meta = {};
    const fn = function () {};
    const ret = eventIn('fire', 'Trigger')(fn, methodCtx('onFire', m));
    expect(ret).toBe(fn);
    expect(buffered(m)[0]).toEqual({
      name: 'fire',
      direction: 'in',
      transport: 'event',
      typeTag: 'Trigger',
      member: 'onFire',
    });
  });
});

it('multiple decorators accumulate into the same buffer', () => {
  const m: Meta = {};
  valueIn('a', 'Float')(undefined, fieldCtx('a', m));
  eventOut('out', 'String')(undefined, fieldCtx('out', m));
  expect(buffered(m)).toHaveLength(2);
});
