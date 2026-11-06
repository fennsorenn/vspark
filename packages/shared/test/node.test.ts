import { describe, it, expect } from 'vitest';
import {
  bufferPort,
  harvestPorts,
  getPortMeta,
  Node,
  type PortMeta,
  type NodeBindContext,
  type Emitter,
} from '../src/node.js';

type Meta = Record<symbol, PortMeta[]>;

describe('port harvesting', () => {
  it('buffers, harvests, and reads back declared ports', () => {
    const m: Meta = {};
    bufferPort(m, {
      name: 'a',
      direction: 'in',
      transport: 'value',
      typeTag: 'Float',
      member: 'a',
    });
    const cls = {};
    harvestPorts(cls, m);
    expect(getPortMeta(cls)).toHaveLength(1);
  });

  it('de-dupes on (direction, name) — last declaration wins', () => {
    const m: Meta = {};
    bufferPort(m, {
      name: 'a',
      direction: 'in',
      transport: 'value',
      typeTag: 'Float',
      member: 'old',
    });
    bufferPort(m, {
      name: 'a',
      direction: 'in',
      transport: 'value',
      typeTag: 'String',
      member: 'new',
    });
    // same name, different DIRECTION → kept separately
    bufferPort(m, {
      name: 'a',
      direction: 'out',
      transport: 'value',
      typeTag: 'Float',
      member: 'aOut',
    });
    const cls = {};
    harvestPorts(cls, m);
    const ports = getPortMeta(cls);
    expect(ports).toHaveLength(2);
    expect(ports.find((p) => p.direction === 'in')?.member).toBe('new');
  });

  it('tolerates undefined metadata and undecorated classes', () => {
    expect(() => bufferPort(undefined, {} as PortMeta)).not.toThrow();
    const cls = {};
    harvestPorts(cls, undefined);
    expect(getPortMeta(cls)).toEqual([]);
    expect(getPortMeta({})).toEqual([]);
  });
});

// ── Node.bind() wiring ────────────────────────────────────────────────────────

class Demo extends Node {
  out!: Emitter<unknown>;
  a!: () => unknown;
  xs!: () => unknown[];
  p = () => (this.a() as number) * 2;
  received: unknown[] = [];
  onFire(payload: unknown) {
    this.received.push(payload);
    this.out.emit(payload);
  }
  // expose protected surface for assertions
  cfg() {
    return this.config;
  }
  st<T>() {
    return this.getState<T>();
  }
  setSt(s: unknown) {
    this.setState(s);
  }
  en() {
    return this.enabled;
  }
  inp(n: string) {
    return this.input(n);
  }
  emit2(n: string, v: unknown) {
    this.emitOn(n, v);
  }
  setDyn(fn: (n: string) => unknown) {
    this.setDynamicOutputs(fn);
  }
}

function harvestDemo() {
  const m: Meta = {};
  const decl: PortMeta[] = [
    {
      name: 'out',
      direction: 'out',
      transport: 'event',
      typeTag: 'String',
      member: 'out',
    },
    {
      name: 'a',
      direction: 'in',
      transport: 'value',
      typeTag: 'Float',
      member: 'a',
    },
    {
      name: 'xs',
      direction: 'in',
      transport: 'list',
      typeTag: 'Float',
      member: 'xs',
    },
    {
      name: 'p',
      direction: 'out',
      transport: 'value',
      typeTag: 'Float',
      member: 'p',
    },
    {
      name: 'fire',
      direction: 'in',
      transport: 'event',
      typeTag: 'Trigger',
      member: 'onFire',
    },
  ];
  for (const d of decl) bufferPort(m, d);
  harvestPorts(Demo, m);
}

function makeCtx() {
  const emitted: [string, unknown][] = [];
  const dynEmits: [string, unknown][] = [];
  let outputThunk: (() => unknown) | undefined;
  let handler: ((p: unknown) => void) | undefined;
  let dynResolve: ((n: string) => unknown) | undefined;
  let state: unknown = { count: 1 };
  const config: Record<string, unknown> = { enabled: true, foo: 'bar' };

  const ctx: NodeBindContext = {
    selfId: 'test-node',
    config,
    getState: <T>() => state as T,
    setState: (s) => {
      state = s;
    },
    makeEmitter: (port) => ({ emit: (v) => emitted.push([port, v]) }),
    valueThunk: (port) => () => (port === 'a' ? 5 : undefined),
    listThunk: (port) => () => (port === 'xs' ? [1, 2, 3] : []),
    registerOutputThunk: (port, fn) => {
      if (port === 'p') outputThunk = fn;
    },
    registerHandler: (port, fn) => {
      if (port === 'fire') handler = fn;
    },
    makeDynamicEmitter: (port) => ({ emit: (v) => dynEmits.push([port, v]) }),
    dynamicValueThunk: (port) => () => `dyn:${port}`,
    registerDynamicOutputs: (fn) => {
      dynResolve = fn;
    },
    isEnabled: () => config.enabled !== false,
  };
  return {
    ctx,
    config,
    emitted,
    dynEmits,
    get outputThunk() {
      return outputThunk;
    },
    get handler() {
      return handler;
    },
    get dynResolve() {
      return dynResolve;
    },
  };
}

describe('Node.bind', () => {
  harvestDemo();

  it('wires inputs, outputs, handlers, and the protected accessors', () => {
    const h = makeCtx();
    const node = new Demo();
    node.bind(h.ctx);

    // value/list input thunks assigned to fields
    expect(node.a()).toBe(5);
    expect(node.xs()).toEqual([1, 2, 3]);

    // event output emitter assigned
    node.out.emit('hi');
    expect(h.emitted).toContainEqual(['out', 'hi']);

    // value output thunk registered → reads this.a()*2 lazily (post-bind)
    expect(h.outputThunk!()).toBe(10);

    // event input handler routes to the method
    h.handler!('payload');
    expect(node.received).toEqual(['payload']);
    expect(h.emitted).toContainEqual(['out', 'payload']);

    // config / state / enabled
    expect(node.cfg()).toEqual({ enabled: true, foo: 'bar' });
    expect(node.st()).toEqual({ count: 1 });
    node.setSt({ count: 2 });
    expect(node.st()).toEqual({ count: 2 });
    expect(node.en()).toBe(true);
    h.config.enabled = false;
    expect(node.en()).toBe(false);
  });

  it('handles dynamic ports (input / emitOn reuse / setDynamicOutputs)', () => {
    const h = makeCtx();
    const node = new Demo();
    node.bind(h.ctx);

    expect(node.inp('z')).toBe('dyn:z');

    node.emit2('dout', 99);
    node.emit2('dout', 100); // reuses the per-name emitter
    expect(h.dynEmits).toEqual([
      ['dout', 99],
      ['dout', 100],
    ]);

    node.setDyn((n) => `r:${n}`);
    expect(h.dynResolve!('q')).toBe('r:q');

    expect(() => node.unbind()).not.toThrow();
  });
});
