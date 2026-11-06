import { describe, it, expect } from 'vitest';
import {
  ACTION_KINDS,
  RESPONSE_TYPES,
  SETTINGS_NODE_KIND,
  actionGraphId,
  actionGraphStatus,
  actionKind,
  buildActionGraph,
  changesShape,
  formatHotkeyCombo,
  graphFingerprint,
  hotkeyPositionCount,
  normalizeSettings,
  settingClassOf,
  shapeOf,
  templateFingerprint,
} from '../src/actions';
import { toDescriptorDoc, type GraphDescriptor } from '../src/signal';

const hk = (over: Record<string, unknown> = {}) =>
  normalizeSettings('hotkey', { ...actionKind('hotkey')!.defaults(), ...over });

const kinds = (g: GraphDescriptor) => g.nodes.map((n) => n.kind);
const edgeStrs = (g: GraphDescriptor) =>
  g.edges.map((e) => `${e.fromNodeId}.${e.fromPort}>${e.toNodeId}.${e.toPort}`);

describe('action kind registry', () => {
  it('registers the kinds; Hotkey with label, icon and fields', () => {
    expect(ACTION_KINDS.map((k) => k.kind)).toEqual([
      'hotkey',
      'chat_command',
    ]);
    const def = actionKind('hotkey')!;
    expect(def.label).toBe('Hotkey');
    expect(def.icon).toBeTruthy();
    expect(def.fields.some((f) => f.class === 'shape')).toBe(true);
    expect(actionKind('nope')).toBeUndefined();
  });

  it('classifies settings paths as value or shape', () => {
    expect(settingClassOf('hotkey', 'mode')).toBe('shape');
    expect(settingClassOf('hotkey', 'positions')).toBe('shape');
    expect(settingClassOf('hotkey', 'responses.3.type')).toBe('shape');
    expect(settingClassOf('hotkey', 'responses.3.clipId')).toBe('value');
    expect(settingClassOf('hotkey', 'shortcut')).toBe('value');
    expect(settingClassOf('hotkey', 'shortcut.key')).toBe('value');
    expect(settingClassOf('unknown', 'mode')).toBe('value');
  });

  it('shapeOf keeps only shape fields', () => {
    const s = hk({
      mode: 'cycle',
      positions: 4,
      shortcut: { key: 'F8' },
      responses: { '0': { type: 'play_clip', clipId: 'c1' }, '1': { foo: 1 } },
    });
    expect(shapeOf('hotkey', s)).toEqual({
      mode: 'cycle',
      positions: 4,
      responses: { '0': { type: 'play_clip' }, '1': {} },
    });
    expect(shapeOf('nope', s)).toEqual({});
  });

  it('normalizes settings: defaults, enums, ranges, unknown response types', () => {
    const def = actionKind('hotkey')!;
    const n = def.normalize({
      mode: 'bogus',
      positions: 99,
      shortcut: { key: 'A', ctrl: 1 },
      responses: { '0': { type: 'explode' }, '1': 'junk' },
      extra: true,
    });
    expect(n.mode).toBe('single');
    expect(n.positions).toBe(8);
    expect(n.shortcut).toEqual({
      key: 'A',
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
    });
    expect(n.responses).toEqual({ '0': {} });
    expect(n.extra).toBe(true);
    expect(def.normalize(null)).toEqual(def.defaults());
    expect(def.normalize({ positions: 'x' }).positions).toBe(3);
    expect(def.normalize({ positions: 0 }).positions).toBe(2);
    // Idempotent.
    expect(def.normalize(def.normalize({ mode: 'toggle' }))).toEqual(
      def.normalize({ mode: 'toggle' })
    );
    expect(normalizeSettings('nope', { a: 1 })).toEqual({ a: 1 });
    expect(normalizeSettings('nope', 'x')).toEqual({});
  });

  it('derives the graph id from the action id', () => {
    expect(actionGraphId('a1')).toBe('a1-graph');
  });
});

describe('Hotkey template', () => {
  it('single: hotkey → response, combo and fields read through settings nodes', () => {
    const g = buildActionGraph(
      'hotkey',
      hk({ responses: { '0': { type: 'play_clip', clipId: 'c1' } } }),
      'g',
      'L'
    );
    expect(g).toMatchObject({ id: 'g', label: 'L', readonly: false });
    expect(kinds(g)).toContain('system_hotkey');
    expect(kinds(g)).toContain('start_clip');
    expect(kinds(g)).not.toContain('cycle');
    expect(edgeStrs(g)).toContain('hotkey.event>response_0.fire');
    expect(edgeStrs(g)).toContain('cfg_shortcut_key.value>hotkey.key');
    expect(edgeStrs(g)).toContain('cfg_response_0_clipId.value>response_0.clipId');
    const cfg = g.nodes.find((n) => n.id === 'cfg_response_0_clipId')!;
    expect(cfg.kind).toBe(SETTINGS_NODE_KIND);
    expect(cfg.defaultConfig).toEqual({ field: 'responses.0.clipId' });
    // No value is baked into the graph.
    expect(JSON.stringify(g)).not.toContain('c1');
  });

  it('toggle: hotkey → cycle(2) → one sink per position', () => {
    const g = buildActionGraph(
      'hotkey',
      hk({
        mode: 'toggle',
        responses: {
          '0': { type: 'set_property' },
          '1': { type: 'set_property' },
        },
      }),
      'g',
      'L'
    );
    expect(g.nodes.find((n) => n.id === 'cycle')?.defaultConfig).toEqual({
      count: 2,
    });
    expect(edgeStrs(g)).toEqual(
      expect.arrayContaining([
        'hotkey.event>cycle.in',
        'cycle.out0>response_0.fire',
        'cycle.out1>response_1.fire',
        'cfg_response_1_paramPath.value>response_1.paramPath',
      ])
    );
  });

  it('cycle: positions sets the count; unset positions stay unconnected', () => {
    const g = buildActionGraph(
      'hotkey',
      hk({
        mode: 'cycle',
        positions: 4,
        responses: { '0': { type: 'control_media' }, '2': { type: 'spawn_clip' } },
      }),
      'g',
      'L'
    );
    expect(g.nodes.find((n) => n.id === 'cycle')?.defaultConfig).toEqual({
      count: 4,
    });
    expect(g.nodes.filter((n) => n.id.startsWith('response_')).map((n) => n.id))
      .toEqual(['response_0', 'response_2']);
    expect(edgeStrs(g)).toContain('cfg_response_0_action.value>response_0.action');
    expect(hotkeyPositionCount(hk({ mode: 'cycle', positions: 4 }))).toBe(4);
    expect(hotkeyPositionCount(hk({ mode: 'toggle' }))).toBe(2);
    expect(hotkeyPositionCount(hk())).toBe(1);
  });

  it('wires every response field to the sink port of the same name', () => {
    for (const [type, def] of Object.entries(RESPONSE_TYPES)) {
      const g = buildActionGraph('hotkey', hk({ responses: { '0': { type } } }), 'g', 'L');
      expect(g.nodes.find((n) => n.id === 'response_0')?.kind).toBe(def.nodeKind);
      for (const f of def.fields)
        expect(edgeStrs(g)).toContain(`cfg_response_0_${f}.value>response_0.${f}`);
    }
  });

  it('unknown kinds build an empty graph', () => {
    expect(buildActionGraph('nope', {}, 'g', 'L').nodes).toEqual([]);
  });
});

describe('fingerprint', () => {
  const base = buildActionGraph('hotkey', hk(), 'g', 'L');

  it('ignores node positions, graph id/label and the document form', () => {
    const moved: GraphDescriptor = {
      ...base,
      id: 'other',
      label: 'Other',
      nodes: base.nodes.map((n) => ({ ...n, position: { x: 999, y: -5 } })).reverse(),
      edges: [...base.edges].reverse(),
    };
    expect(graphFingerprint(moved)).toBe(graphFingerprint(base));
    expect(graphFingerprint(toDescriptorDoc(base))).toBe(graphFingerprint(base));
  });

  it('changes on a config edit, an added node or a removed edge', () => {
    const fp = graphFingerprint(base);
    const cfgEdit = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === 'hotkey' ? { ...n, defaultConfig: { key: 'F1' } } : n
      ),
    };
    expect(graphFingerprint(cfgEdit)).not.toBe(fp);
    expect(
      graphFingerprint({
        ...base,
        nodes: [...base.nodes, { id: 'x', kind: 'log', position: { x: 0, y: 0 } }],
      })
    ).not.toBe(fp);
    expect(graphFingerprint({ ...base, edges: base.edges.slice(1) })).not.toBe(fp);
    expect(graphFingerprint(null)).toBe(graphFingerprint({ id: '', label: '', readonly: false, nodes: [], edges: [] }));
  });

  it('value settings do not change the template output; shape settings do', () => {
    const a = hk({ responses: { '0': { type: 'play_clip', clipId: 'c1' } } });
    const b = hk({
      shortcut: { key: 'F9', ctrl: true },
      responses: { '0': { type: 'play_clip', clipId: 'c2' } },
    });
    expect(templateFingerprint('hotkey', a)).toBe(templateFingerprint('hotkey', b));
    expect(changesShape('hotkey', a, b)).toBe(false);
    expect(changesShape('hotkey', a, hk({ mode: 'toggle' }))).toBe(true);
    expect(
      changesShape('hotkey', a, hk({ responses: { '0': { type: 'spawn_clip' } } }))
    ).toBe(true);
    // positions only matters in cycle mode.
    expect(changesShape('hotkey', a, { ...a, positions: 5 })).toBe(false);
    expect(
      changesShape('hotkey', { ...a, mode: 'cycle' }, { ...a, mode: 'cycle', positions: 5 })
    ).toBe(true);
  });

  it('status: modified, template update available, missing graph', () => {
    const settings = hk();
    const fp = templateFingerprint('hotkey', settings);
    const graph = buildActionGraph('hotkey', settings, 'g', 'L');
    const action = { kind: 'hotkey', settings, templateFingerprint: fp };
    expect(actionGraphStatus(action, graph)).toEqual({
      missingGraph: false,
      modified: false,
      templateUpdateAvailable: false,
    });
    const edited = { ...graph, edges: graph.edges.slice(1) };
    expect(actionGraphStatus(action, edited).modified).toBe(true);
    expect(
      actionGraphStatus({ ...action, settings: hk({ mode: 'toggle' }) }, graph)
        .templateUpdateAvailable
    ).toBe(true);
    expect(actionGraphStatus(action, null)).toEqual({
      missingGraph: true,
      modified: false,
      templateUpdateAvailable: false,
    });
    expect(
      actionGraphStatus({ kind: 'hotkey', settings }, graph).modified
    ).toBe(true);
  });
});

describe('Hotkey preview', () => {
  const preview = (s: Record<string, unknown>) =>
    actionKind('hotkey')!.preview(hk(s));

  it('shows the combo and the response with its references', () => {
    const p = preview({
      shortcut: { key: 'F8', ctrl: true, shift: true },
      responses: { '0': { type: 'play_clip', clipId: 'c1' } },
    });
    expect(p.headline).toEqual([{ t: 'text', text: 'Ctrl + Shift + F8' }]);
    expect(p.lines).toEqual([
      [
        { t: 'msg', key: 'responses.play_clip' },
        { t: 'ref', ref: 'clip', id: 'c1' },
      ],
    ]);
  });

  it('marks a missing shortcut and a missing response', () => {
    const p = preview({ responses: { '0': {} } });
    expect(p.headline).toEqual([{ t: 'msg', key: 'preview.noShortcut' }]);
    expect(p.lines).toEqual([[{ t: 'msg', key: 'preview.noResponse' }]]);
  });

  it('numbers positions for toggle and cycle', () => {
    const t = preview({ mode: 'toggle', responses: {} });
    expect(t.headline[1]).toEqual({ t: 'msg', key: 'preview.toggle' });
    expect(t.lines).toHaveLength(2);
    expect(t.lines[1][0]).toEqual({
      t: 'msg',
      key: 'preview.position',
      params: { n: 2 },
    });
    const c = preview({ mode: 'cycle', positions: 3, responses: {} });
    expect(c.headline[1]).toEqual({
      t: 'msg',
      key: 'preview.cycle',
      params: { n: 3 },
    });
  });

  it('summarizes every response type', () => {
    const line = (resp: Record<string, unknown>) =>
      preview({ responses: { '0': resp } }).lines[0];
    expect(line({ type: 'set_expression', nodeId: 'n1', expression: 'happy' })).toEqual([
      { t: 'msg', key: 'responses.set_expression' },
      { t: 'ref', ref: 'sceneNode', id: 'n1' },
      { t: 'text', text: 'happy' },
    ]);
    expect(
      line({ type: 'set_property', targetId: 'n1', paramPath: 'visible', value: false })
    ).toContainEqual({ t: 'text', text: 'visible = false' });
    expect(
      line({ type: 'set_layer_property', targetId: 'l1', paramPath: 'x', value: 4 })
    ).toContainEqual({ t: 'ref', ref: 'composeLayer', id: 'l1' });
    expect(line({ type: 'control_media', target: 'v1', action: 'pause' })).toEqual([
      { t: 'msg', key: 'responses.control_media' },
      { t: 'ref', ref: 'sceneEntity', id: 'v1' },
      { t: 'msg', key: 'mediaAction.pause' },
    ]);
    expect(line({ type: 'spawn_clip' })).toEqual([
      { t: 'msg', key: 'responses.spawn_clip' },
    ]);
    expect(line({ type: 'set_property', value: null })).toEqual([
      { t: 'msg', key: 'responses.set_property' },
    ]);
  });

  it('formats combos like the Macros recorder', () => {
    expect(formatHotkeyCombo({ key: 'UP ARROW', alt: true, meta: true })).toBe(
      'Alt + Meta + Up Arrow'
    );
    expect(formatHotkeyCombo({ key: ' ' })).toBe('');
    expect(formatHotkeyCombo({})).toBe('');
  });
});
