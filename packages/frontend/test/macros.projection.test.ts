import { describe, it, expect } from 'vitest';
import type { GraphDescriptor } from '@vspark/shared/signal';
import {
  MACRO_ACTION_DEFS,
  macroActionById,
} from '../src/components/editor/macros/actionRegistry';
import {
  assembleSingleMacro,
  assembleCycleMacro,
} from '../src/components/editor/macros/build';
import { projectMacros } from '../src/components/editor/macros/projection';
import type {
  HotkeyCombo,
  MacroActionValues,
} from '../src/components/editor/macros/types';

/** Deterministic id generator (no Math.random → stable snapshots). */
function idGen(prefix = 'n') {
  let i = 0;
  return () => `${prefix}${i++}`;
}

const COMBO: HotkeyCombo = {
  key: 'F8',
  ctrl: true,
  shift: false,
  alt: false,
  meta: false,
};

/** Representative field values per action def, for the round-trip check. */
const SAMPLE_VALUES: Record<string, MacroActionValues> = {
  play_clip: { clipId: 'clip-123' },
  spawn_clip: { clipId: 'clip-456' },
  set_expression: { nodeId: 'avatar-1', expression: 'Happy', weight: 0.8 },
  set_property: { targetId: 'node-1', paramPath: 'visible', value: false },
  set_layer_property: { targetId: 'layer-1', paramPath: 'opacity', value: 0.5 },
  control_media: { target: 'video-1', action: 'play' },
};

function wrap(nodes: GraphDescriptor['nodes'], edges: GraphDescriptor['edges']): GraphDescriptor {
  return { id: 'g', label: 'g', readonly: false, nodes, edges };
}

describe('macro action registry — match/build are inverses', () => {
  for (const def of MACRO_ACTION_DEFS) {
    it(`${def.id}: match(build(v)) === v`, () => {
      const values = SAMPLE_VALUES[def.id];
      expect(values, `sample values for ${def.id}`).toBeDefined();
      const built = def.build(values, idGen());
      const entry = built.nodes.find((n) => n.id === built.entryNodeId)!;
      expect(entry.kind).toBe(def.nodeKind);
      expect(def.match(entry, wrap(built.nodes, built.edges))).toEqual(values);
    });
  }

  it('build omits undefined field values from defaultConfig', () => {
    const def = macroActionById('set_expression')!;
    const built = def.build({ nodeId: 'a', expression: undefined, weight: undefined }, idGen());
    const entry = built.nodes[0];
    expect(entry.defaultConfig).toEqual({ nodeId: 'a' });
    // …and match reads the missing ones back as undefined (round-trips).
    expect(def.match(entry, wrap(built.nodes, built.edges))).toEqual({
      nodeId: 'a',
      expression: undefined,
      weight: undefined,
    });
  });
});

describe('projection — single-action macros', () => {
  it('projects an assembled single macro back to a single row', () => {
    const action = { defId: 'set_expression', values: SAMPLE_VALUES.set_expression };
    const g = assembleSingleMacro(COMBO, action, idGen());
    const rows = projectMacros([{ logicId: 'L1', descriptor: wrap(g.nodes, g.edges) }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      logicId: 'L1',
      kind: 'single',
      shortcut: COMBO,
      action: { defId: 'set_expression', values: SAMPLE_VALUES.set_expression },
    });
  });

  it('every action def round-trips through a single-macro projection', () => {
    for (const def of MACRO_ACTION_DEFS) {
      const action = { defId: def.id, values: SAMPLE_VALUES[def.id] };
      const g = assembleSingleMacro(COMBO, action, idGen());
      const [row] = projectMacros([{ logicId: 'L', descriptor: wrap(g.nodes, g.edges) }]);
      expect(row.kind, def.id).toBe('single');
      expect(row.action, def.id).toEqual(action);
    }
  });
});

describe('projection — cycle (toggle) macros', () => {
  it('projects a 2-state cycle back to a cycle row', () => {
    const states = [
      { defId: 'set_expression', values: { nodeId: 'a', expression: 'Happy', weight: 1 } },
      { defId: 'set_expression', values: { nodeId: 'a', expression: 'Happy', weight: 0 } },
    ];
    const g = assembleCycleMacro(COMBO, states, idGen());
    const [row] = projectMacros([{ logicId: 'L', descriptor: wrap(g.nodes, g.edges) }]);
    expect(row.kind).toBe('cycle');
    expect(row.states).toEqual(states);
  });

  it('a null cycle state projects back as null (custom/unset slot)', () => {
    const states = [
      { defId: 'play_clip', values: { clipId: 'c1' } },
      null,
    ];
    const g = assembleCycleMacro(COMBO, states, idGen());
    const [row] = projectMacros([{ logicId: 'L', descriptor: wrap(g.nodes, g.edges) }]);
    expect(row.kind).toBe('cycle');
    expect(row.states).toEqual(states);
  });
});

describe('projection — conservative classification', () => {
  const hk = {
    id: 'hk',
    kind: 'system_hotkey',
    position: { x: 0, y: 0 },
    defaultConfig: { key: 'F8' },
  };

  it('a hotkey with no downstream is empty', () => {
    const [row] = projectMacros([{ logicId: 'L', descriptor: wrap([hk], []) }]);
    expect(row.kind).toBe('empty');
    expect(row.shortcut.key).toBe('F8');
  });

  it('fan-out from the raw hotkey event is opaque', () => {
    const a = { id: 'a', kind: 'start_clip', position: { x: 0, y: 0 }, defaultConfig: {} };
    const b = { id: 'b', kind: 'start_clip', position: { x: 0, y: 0 }, defaultConfig: {} };
    const edges = [
      { fromNodeId: 'hk', fromPort: 'event', toNodeId: 'a', toPort: 'fire' },
      { fromNodeId: 'hk', fromPort: 'event', toNodeId: 'b', toPort: 'fire' },
    ];
    const [row] = projectMacros([{ logicId: 'L', descriptor: wrap([hk, a, b], edges) }]);
    expect(row.kind).toBe('opaque');
  });

  it('an action node with an extra wired input is opaque (lossless guard)', () => {
    const action = { id: 'a', kind: 'set_expression', position: { x: 0, y: 0 }, defaultConfig: { nodeId: 'av', expression: 'Happy' } };
    const src = { id: 'w', kind: 'random', position: { x: 0, y: 0 }, defaultConfig: {} };
    const edges = [
      { fromNodeId: 'hk', fromPort: 'event', toNodeId: 'a', toPort: 'fire' },
      // a value wired into the action's `weight` port → the inline form can't show it.
      { fromNodeId: 'w', fromPort: 'value', toNodeId: 'a', toPort: 'weight' },
    ];
    const [row] = projectMacros([{ logicId: 'L', descriptor: wrap([hk, action, src], edges) }]);
    expect(row.kind).toBe('opaque');
  });

  it('an unmodeled sink kind is opaque', () => {
    const sink = { id: 'x', kind: 'log', position: { x: 0, y: 0 }, defaultConfig: {} };
    const edges = [{ fromNodeId: 'hk', fromPort: 'event', toNodeId: 'x', toPort: 'trigger' }];
    const [row] = projectMacros([{ logicId: 'L', descriptor: wrap([hk, sink], edges) }]);
    expect(row.kind).toBe('opaque');
  });

  it('projects one row per hotkey across multiple graphs', () => {
    const g1 = assembleSingleMacro(COMBO, { defId: 'play_clip', values: { clipId: 'c' } }, idGen('a'));
    const rows = projectMacros([
      { logicId: 'L1', descriptor: wrap(g1.nodes, g1.edges) },
      { logicId: 'L2', descriptor: wrap([hk], []) },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind).sort()).toEqual(['empty', 'single']);
  });
});
