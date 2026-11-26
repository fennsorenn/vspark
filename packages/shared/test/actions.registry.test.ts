import { afterEach, describe, expect, it } from 'vitest';
import {
  ACTION_KINDS,
  RESPONSE_TYPE_IDS,
  RegistrationError,
  Tpl,
  actionKind,
  buildActionGraph,
  normalizeSettings,
  registerActionKind,
  registerResponseType,
  responseTypeIds,
  unregisterActionContributions,
  type ActionKindDef,
} from '../src/actions';
import {
  COMPOSITE_TYPES,
  registerCompositeType,
  unregisterCompositeContributions,
} from '../src/composites';

/** Plugin-system phase 1: built-in registries accept plugin contributions. */

const fakeKind = (kind: string): ActionKindDef => ({
  kind,
  label: 'Fake',
  icon: '🧪',
  fields: [],
  form: [{ path: 'text', control: 'text', label: 'field.text', hint: 'field.textHint' }],
  defaults: () => ({ text: '' }),
  normalize: (raw) => ({ text: typeof (raw as { text?: unknown })?.text === 'string' ? (raw as { text: string }).text : '' }),
  build: () => {
    const b = new Tpl();
    b.node('t', 'on_trigger', 0, 0);
    b.setting('text', 't', 'name', -280, 0);
    return b.out();
  },
  preview: (s) => ({ headline: [{ t: 'text', text: String(s.text) }], lines: [] }),
});

afterEach(() => {
  unregisterActionContributions('demo');
  unregisterCompositeContributions('demo');
});

describe('response type registration', () => {
  it('adds a plugin type with qualified labels; visible to every response kind', () => {
    registerResponseType('demo', 'demo_ping', {
      nodeKind: 'demo_ping',
      entryPort: 'fire',
      fields: ['volume'],
      label: 'response.ping',
      form: [{ path: 'volume', control: 'slider', label: 'field.volume' }],
    });
    expect(responseTypeIds()).toContain('demo_ping');
    expect(RESPONSE_TYPE_IDS).not.toContain('demo_ping'); // built-in snapshot
    const s = normalizeSettings('hotkey', {
      responses: { 0: { type: 'demo_ping', volume: 3 } },
    });
    expect((s.responses as Record<string, { type?: string }>)[0]!.type).toBe('demo_ping');
    const g = buildActionGraph('named_trigger', { name: 'x', response: { type: 'demo_ping', volume: 3 } }, 'g', 'L');
    expect(g.nodes.find((n) => n.id === 'response')?.kind).toBe('demo_ping');
    expect(g.edges.some((e) => e.toNodeId === 'response' && e.toPort === 'volume')).toBe(true);
    const preview = actionKind('named_trigger')!.preview(
      normalizeSettings('named_trigger', { response: { type: 'demo_ping' } })
    );
    expect(preview.lines[0]![0]).toEqual({ t: 'msg', key: 'plugin-demo:response.ping' });
  });

  it('refuses unprefixed, built-in and duplicate ids', () => {
    const def = { nodeKind: 'x', entryPort: 'fire', fields: [] };
    expect(() => registerResponseType('demo', 'ping', def)).toThrow(RegistrationError);
    expect(() => registerResponseType('demo', 'play_clip', def)).toThrow(RegistrationError);
    expect(() => registerResponseType('Bad-Id', 'Bad-Id_x', def)).toThrow(RegistrationError);
    registerResponseType('demo', 'demo_x', def);
    expect(() => registerResponseType('demo', 'demo_x', def)).toThrow(/already exists/);
  });

  it('unregistering drops the type; stored slots of it normalize to no response', () => {
    registerResponseType('demo', 'demo_ping', { nodeKind: 'demo_ping', entryPort: 'fire', fields: [] });
    unregisterActionContributions('demo');
    expect(responseTypeIds()).not.toContain('demo_ping');
    const s = normalizeSettings('named_trigger', { response: { type: 'demo_ping' } });
    expect((s.response as { type?: string }).type).toBeUndefined();
  });
});

describe('action kind registration', () => {
  it('adds a kind after the built-ins with a qualified form', () => {
    const before = ACTION_KINDS.length;
    registerActionKind('demo', fakeKind('demo_fake'));
    expect(ACTION_KINDS.length).toBe(before + 1);
    const def = actionKind('demo_fake')!;
    expect(def.plugin).toBe('demo');
    expect(def.form![0]).toMatchObject({ label: 'plugin-demo:field.text', hint: 'plugin-demo:field.textHint' });
    const g = buildActionGraph('demo_fake', { text: 'hi' }, 'g', 'L');
    expect(g.nodes.map((n) => n.kind)).toEqual(['on_trigger', 'settings']);
    unregisterActionContributions('demo');
    expect(actionKind('demo_fake')).toBeUndefined();
    expect(ACTION_KINDS.length).toBe(before);
  });

  it('refuses unprefixed and duplicate kinds', () => {
    expect(() => registerActionKind('demo', fakeKind('hotkey'))).toThrow(RegistrationError);
    registerActionKind('demo', fakeKind('demo_fake'));
    expect(() => registerActionKind('demo', fakeKind('demo_fake'))).toThrow(/already exists/);
  });
});

describe('composite type registration', () => {
  it('adds and removes a plugin composite type', () => {
    registerCompositeType('demo', { type: 'demo_banner', rootRtype: 'compose_layer', parts: { panel: 'compose_layer' }, settings: [] });
    expect(COMPOSITE_TYPES.demo_banner?.plugin).toBe('demo');
    expect(() =>
      registerCompositeType('demo', { type: 'alert', rootRtype: 'compose_layer', parts: {}, settings: [] })
    ).toThrow();
    unregisterCompositeContributions('demo');
    expect(COMPOSITE_TYPES.demo_banner).toBeUndefined();
    expect(COMPOSITE_TYPES.alert).toBeDefined();
  });
});
