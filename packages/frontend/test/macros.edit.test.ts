import { describe, it, expect } from 'vitest';
import type { GraphDescriptor } from '@vspark/shared/signal';
import {
  assembleSingleMacro,
  assembleCycleMacro,
} from '../src/components/editor/macros/build';
import {
  removeMacro,
  patchNodeConfig,
  setSingleAction,
  reachableFrom,
} from '../src/components/editor/macros/edit';
import { projectMacros } from '../src/components/editor/macros/projection';
import type { HotkeyCombo } from '../src/components/editor/macros/types';

function idGen(p = 'n') {
  let i = 0;
  return () => `${p}${i++}`;
}
const COMBO: HotkeyCombo = { key: 'F8', ctrl: false, shift: false, alt: false, meta: false };
function wrap(nodes: GraphDescriptor['nodes'], edges: GraphDescriptor['edges']): GraphDescriptor {
  return { id: 'g', label: 'Macros', readonly: false, nodes, edges };
}

describe('reachableFrom', () => {
  it('walks outgoing edges and excludes the start node', () => {
    const g = assembleSingleMacro(COMBO, { defId: 'play_clip', values: { clipId: 'c' } }, idGen());
    const d = wrap(g.nodes, g.edges);
    const hk = d.nodes.find((n) => n.kind === 'system_hotkey')!;
    const reach = reachableFrom(d, hk.id);
    expect(reach.size).toBe(1); // the start_clip node
    expect(reach.has(hk.id)).toBe(false);
  });
});

describe('removeMacro', () => {
  it('removes a macro and leaves other macros untouched', () => {
    const a = assembleSingleMacro(COMBO, { defId: 'play_clip', values: { clipId: 'c1' } }, idGen('a'));
    const b = assembleSingleMacro(
      { key: 'F9', ctrl: false, shift: false, alt: false, meta: false },
      { defId: 'play_clip', values: { clipId: 'c2' } },
      idGen('b')
    );
    let d = wrap([...a.nodes, ...b.nodes], [...a.edges, ...b.edges]);
    expect(projectMacros([{ logicId: 'L', descriptor: d }])).toHaveLength(2);

    const hkA = a.nodes.find((n) => n.kind === 'system_hotkey')!;
    d = removeMacro(d, hkA.id);
    const rows = projectMacros([{ logicId: 'L', descriptor: d }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].shortcut.key).toBe('F9');
    // No orphaned nodes/edges from macro A remain.
    expect(d.nodes.some((n) => a.nodes.some((an) => an.id === n.id))).toBe(false);
    expect(d.edges.some((e) => a.edges.some((ae) => ae.fromNodeId === e.fromNodeId && ae.toNodeId === e.toNodeId))).toBe(false);
  });

  it('removes a cycle macro including all its state nodes', () => {
    const g = assembleCycleMacro(
      COMBO,
      [
        { defId: 'play_clip', values: { clipId: 'x' } },
        { defId: 'play_clip', values: { clipId: 'y' } },
      ],
      idGen()
    );
    let d = wrap(g.nodes, g.edges);
    const hk = d.nodes.find((n) => n.kind === 'system_hotkey')!;
    d = removeMacro(d, hk.id);
    expect(d.nodes).toHaveLength(0);
    expect(d.edges).toHaveLength(0);
  });
});

describe('patchNodeConfig', () => {
  it('merges into a node defaultConfig (used for enable + shortcut edits)', () => {
    const g = assembleSingleMacro(COMBO, { defId: 'play_clip', values: { clipId: 'c' } }, idGen());
    let d = wrap(g.nodes, g.edges);
    const hk = d.nodes.find((n) => n.kind === 'system_hotkey')!;
    d = patchNodeConfig(d, hk.id, { enabled: false });
    const patched = d.nodes.find((n) => n.id === hk.id)!;
    expect(patched.defaultConfig).toMatchObject({ key: 'F8', enabled: false });
  });
});

describe('setSingleAction', () => {
  it('swaps a macro action in place and re-projects to the new action', () => {
    const g = assembleSingleMacro(COMBO, { defId: 'play_clip', values: { clipId: 'c' } }, idGen('a'));
    let d = wrap(g.nodes, g.edges);
    const hk = d.nodes.find((n) => n.kind === 'system_hotkey')!;

    const newAction = { defId: 'set_expression', values: { nodeId: 'av', expression: 'Happy', weight: 1 } };
    d = setSingleAction(d, hk.id, newAction, idGen('b'));

    const [row] = projectMacros([{ logicId: 'L', descriptor: d }]);
    expect(row.kind).toBe('single');
    expect(row.action).toEqual(newAction);
    // Old start_clip node is gone; exactly hotkey + new action node remain.
    expect(d.nodes.map((n) => n.kind).sort()).toEqual(['set_expression', 'system_hotkey']);
    expect(d.nodes.some((n) => n.kind === 'start_clip')).toBe(false);
  });

  it('clearing the action leaves a triggerless (empty) hotkey', () => {
    const g = assembleSingleMacro(COMBO, { defId: 'play_clip', values: { clipId: 'c' } }, idGen());
    let d = wrap(g.nodes, g.edges);
    const hk = d.nodes.find((n) => n.kind === 'system_hotkey')!;
    d = setSingleAction(d, hk.id, null, idGen('z'));
    const [row] = projectMacros([{ logicId: 'L', descriptor: d }]);
    expect(row.kind).toBe('empty');
    expect(d.nodes).toHaveLength(1);
  });
});
