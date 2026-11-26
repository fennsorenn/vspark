import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, eventOut, valueIn, valueOut } from '@vspark/shared/node_decorators';
import { RegistrationError } from '@vspark/shared/actions';
import {
  NODE_REGISTRY,
  getAllNodeKindMeta,
  pluginOfNodeKind,
  registerNodeKinds,
  unregisterNodeKinds,
} from '../src/signal/registry.js';
import {
  BUILTIN_COMPOSITES,
  getBuiltinPreset,
  registerBuiltinComposite,
  unregisterBuiltinComposites,
} from '../src/presets/builtins.js';
import { makeTestApp } from './helpers/testApp.js';
import { pullValue } from './helpers/nodeHarness.js';

/**
 * Plugin-system phase 1: plugins add node kinds and composite payloads to the
 * built-in registries. The node classes here are decorated with the host's
 * decorators, as the injected plugin SDK will provide them.
 */

@SignalNode({ label: 'Demo: Echo', tags: ['demo'], color: '#333333' })
class DemoEcho extends Node {
  static readonly kind = 'demo_echo';
  @valueIn('text', 'String') text!: () => string | undefined;
  @eventOut('done', 'Trigger') done!: Emitter<void>;
  @valueOut('out', 'String') out = (): string => `echo:${this.text() ?? ''}`;
  @eventIn('fire', 'Trigger')
  onFire(): void {
    this.setState(this.out());
    this.done.emit(undefined);
  }
}

/** Not decorated with @SignalNode: what a plugin bundling its own SDK copy yields. */
class Undecorated extends Node {
  static readonly kind = 'demo_bare';
}

afterEach(() => {
  unregisterNodeKinds('demo');
  unregisterBuiltinComposites('demo');
});

describe('node kind registration', () => {
  it('registers a plugin node that runs in the engine and shows in the catalog', async () => {
    registerNodeKinds('demo', [DemoEcho]);
    expect(NODE_REGISTRY.get('demo_echo')).toBe(DemoEcho);
    expect(pluginOfNodeKind('demo_echo')).toBe('demo');
    expect(pullValue('demo_echo', 'out', { text: 'hi' })).toBe('echo:hi');

    const meta = getAllNodeKindMeta().find((m) => m.kind === 'demo_echo')!;
    expect(meta.plugin).toBe('demo');
    expect(meta.inputPorts.map((p) => p.name)).toEqual(expect.arrayContaining(['text', 'fire']));
    expect(getAllNodeKindMeta().find((m) => m.kind === 'log')?.plugin).toBeUndefined();

    const { app } = await makeTestApp();
    const res = await request(app).get('/api/signal/node-kinds');
    expect(res.body.data.some((m: { kind: string }) => m.kind === 'demo_echo')).toBe(true);
  });

  it('refuses unprefixed, duplicate and undecorated kinds, all-or-nothing', () => {
    expect(() => registerNodeKinds('other', [DemoEcho])).toThrow(RegistrationError);
    expect(() => registerNodeKinds('demo', [DemoEcho, DemoEcho])).toThrow(/already exists/);
    expect(() => registerNodeKinds('demo', [DemoEcho, Undecorated])).toThrow(/@SignalNode/);
    expect(NODE_REGISTRY.has('demo_echo')).toBe(false);
  });

  it('unregistering removes only the plugin kinds', () => {
    registerNodeKinds('demo', [DemoEcho]);
    const n = NODE_REGISTRY.size;
    unregisterNodeKinds('demo');
    expect(NODE_REGISTRY.size).toBe(n - 1);
    expect(NODE_REGISTRY.has('log')).toBe(true);
  });
});

describe('composite payload registration', () => {
  const payload = () => ({
    ...structuredClone(BUILTIN_COMPOSITES[0]!),
    id: 'plugin:demo:banner',
    name: 'Demo banner',
    composite: 'demo_banner',
  });

  it('registers a payload served by the composites list and the builtin lookup', async () => {
    registerBuiltinComposite('demo', payload());
    expect(getBuiltinPreset('plugin:demo:banner')).toBeDefined();
    const { app } = await makeTestApp();
    const list = await request(app).get('/api/presets/composites');
    const row = list.body.data.find((p: { id: string }) => p.id === 'plugin:demo:banner');
    expect(row).toMatchObject({ composite: 'demo_banner', plugin: 'demo' });
    const one = await request(app).get('/api/presets/builtin/plugin:demo:banner');
    expect(one.status).toBe(200);
  });

  it('refuses ids outside the plugin namespace and duplicates', () => {
    expect(() => registerBuiltinComposite('demo', { ...payload(), id: 'builtin:x' })).toThrow();
    expect(() => registerBuiltinComposite('demo', { ...payload(), composite: 'alert' })).toThrow();
    registerBuiltinComposite('demo', payload());
    expect(() => registerBuiltinComposite('demo', payload())).toThrow(/already exists/);
    unregisterBuiltinComposites('demo');
    expect(getBuiltinPreset('plugin:demo:banner')).toBeUndefined();
  });
});
