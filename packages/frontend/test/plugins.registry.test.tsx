/**
 * Plugin-system phase 1 in the editor: a registered plugin Action kind gets a
 * generated form, a plugin response type shows up in every response picker
 * with its declared fields, and a plugin composite joins the palette defs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Tpl,
  actionGraphId,
  actionKind,
  buildActionGraph,
  registerActionKind,
  registerResponseType,
  templateFingerprint,
  unregisterActionContributions,
  type ActionKindDef,
} from '@vspark/shared/actions';
import { toDescriptorDoc } from '@vspark/shared/signal';
import { renderWithProviders, userEvent } from './helpers/render';
import { seedEditor, testPeer } from './helpers/mesh';
import { DialogProvider } from '../src/components/DialogProvider';
import { ActionsPanel } from '../src/components/editor/actions/ActionsPanel';
import { ActionEditor } from '../src/components/editor/actions/ActionEditor';
import { effectiveFields } from '../src/components/editor/actions/responseFields';
import {
  COMPOSITE_DEFS,
  compositeLabelKey,
  registerCompositeDef,
  unregisterCompositeDefs,
} from '../src/components/editor/composites/compositeModel';
import type { ActionRecord } from '../src/mesh/actions';
import { useEditorStore } from '../src/store/editorStore';

const P = 'proj-plugins';
const actions = () => testPeer().collection<ActionRecord>('action');
const logic = () => testPeer().collection<Record<string, unknown>>('logic');
const settingsOf = (id: string) => actions().get(id)!.settings as Record<string, any>;

const demoKind: ActionKindDef = {
  kind: 'demo_greeter',
  label: 'Greeter',
  icon: '👋',
  fields: [{ path: 'mode', class: 'shape' }],
  form: [
    { path: 'mode', control: 'select', label: 'field.mode', options: ['a', 'b'] },
    { path: 'greeting', control: 'text', label: 'field.greeting', placeholders: ['user'] },
    { path: 'loud', control: 'toggle', label: 'field.loud' },
    { path: 'repeat', control: 'number', label: 'field.repeat', min: 1, when: (r) => r('loud') === true },
  ],
  defaults: () => ({ mode: 'a', greeting: '', loud: false, repeat: 1 }),
  normalize: (raw) => ({ mode: 'a', greeting: '', loud: false, repeat: 1, ...(raw as object) }),
  build: (shape) => {
    const b = new Tpl();
    b.node(shape.mode === 'b' ? 'tb' : 'ta', 'on_trigger', 0, 0);
    return b.out();
  },
  preview: (s) => ({ headline: [{ t: 'text', text: String(s.greeting || '—') }], lines: [[{ t: 'msg', key: 'preview.loud' }]] }),
};

function seed(id: string, kind: string, over: Record<string, unknown> = {}) {
  const def = actionKind(kind)!;
  const settings = def.normalize({ ...def.defaults(), ...over });
  actions().put(
    { id, projectId: P, kind, name: id, enabled: true, settings, templateFingerprint: templateFingerprint(kind, settings), createdAt: `2026-01-01-${id}` },
    { v: { t: 1, c: 0, n: 'seed' } }
  );
  logic().put(
    { id: actionGraphId(id), ownerKind: 'action', ownerId: id, name: id, enabled: true, descriptor: toDescriptorDoc(buildActionGraph(kind, settings, actionGraphId(id), id)) },
    { v: { t: 1, c: 0, n: 'seed' } }
  );
}

const renderPanel = () =>
  renderWithProviders(
    <DialogProvider>
      <ActionsPanel projectId={P} />
      <ActionEditor projectId={P} />
    </DialogProvider>
  );

beforeEach(() => {
  registerActionKind('demo', demoKind);
  registerResponseType('demo', 'demo_beep', {
    nodeKind: 'demo_beep',
    entryPort: 'fire',
    fields: ['pitch'],
    label: 'response.beep',
    form: [{ path: 'pitch', control: 'slider', label: 'field.pitch', min: 0, max: 10 }],
  });
  useEditorStore.setState({ activeActionId: null });
  seedEditor({ projectId: P, nodes: [] });
});

afterEach(() => {
  unregisterActionContributions('demo');
  unregisterCompositeDefs('demo');
});

describe('plugin Action kind', () => {
  it('lists the kind as a group and renders its generated form', async () => {
    seed('g1', 'demo_greeter', { greeting: 'hi' });
    const user = userEvent.setup();
    const { container } = renderPanel();
    expect(container.querySelector('.vs-action-group-demo_greeter')).not.toBeNull();
    await user.click(container.querySelector('.vs-action-row')!);
    const form = container.querySelector('.vs-action-schema-form')!;
    expect(form.querySelector('.vs-action-schema-field-greeting')).not.toBeNull();
    // `repeat` is hidden until `loud` is on.
    expect(form.querySelector('.vs-action-schema-field-repeat')).toBeNull();
    await user.click(form.querySelector('.vs-action-schema-field-loud')!);
    expect(settingsOf('g1').loud).toBe(true);
    expect(container.querySelector('.vs-action-schema-field-repeat')).not.toBeNull();
  });

  it('a text field is a value write; a shape select rebuilds the graph', async () => {
    seed('g2', 'demo_greeter');
    const user = userEvent.setup();
    const { container } = renderPanel();
    await user.click(container.querySelector('.vs-action-row')!);
    const text = container.querySelector('.vs-action-schema-field-greeting') as HTMLInputElement;
    await user.type(text, 'hello{Enter}');
    expect(settingsOf('g2').greeting).toBe('hello');
    await user.selectOptions(container.querySelector('.vs-action-schema-field-mode') as HTMLSelectElement, 'b');
    const desc = logic().get(actionGraphId('g2'))!.descriptor as { nodes: Record<string, unknown> };
    expect(Object.keys(desc.nodes)).toContain('tb');
  });
});

describe('plugin response type', () => {
  it('maps the declared form to response fields', () => {
    expect(effectiveFields('demo_beep', {})).toEqual([
      expect.objectContaining({ key: 'pitch', labelKey: 'plugin-demo:field.pitch', control: 'slider', min: 0, max: 10 }),
    ]);
  });

  it('is offered by a built-in kind response picker', async () => {
    seed('nt', 'named_trigger');
    const user = userEvent.setup();
    const { container } = renderPanel();
    await user.click(container.querySelector('.vs-action-row')!);
    const select = container.querySelector('.vs-action-response-type') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toContain('demo_beep');
    await user.selectOptions(select, 'demo_beep');
    expect(settingsOf('nt').response.type).toBe('demo_beep');
    expect(container.querySelector('.vs-action-field-pitch')).not.toBeNull();
  });
});

describe('plugin composite', () => {
  it('joins the palette defs with a default icon and a plugin label key', () => {
    registerCompositeDef('demo', { type: 'demo_banner', presetId: 'plugin:demo:banner', rootRtype: 'compose_layer', label: 'Banner' });
    const def = COMPOSITE_DEFS.find((d) => d.type === 'demo_banner')!;
    expect(def.icon).toBeDefined();
    expect(compositeLabelKey(def)).toBe('plugin-demo:type.demo_banner');
    expect(() => registerCompositeDef('demo', { type: 'alert', presetId: 'x', rootRtype: 'compose_layer', label: 'x' })).toThrow();
  });
});
