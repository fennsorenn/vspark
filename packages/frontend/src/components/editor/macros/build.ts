/**
 * Macro build helpers — assemble the descriptor subgraph for a macro (the
 * UI → graph direction). Pure: fresh ids come from an injected `makeId` so the
 * splice/persist layer (Stage 3) controls id allocation and these stay testable.
 *
 * These are the inverse of projection.ts: `projectMacros(assembleSingleMacro(...))`
 * round-trips back to the same row.
 */

import type {
  GraphNodeDescriptor,
  GraphEdgeDescriptor,
} from '@vspark/shared/signal';
import { macroActionById } from './actionRegistry.js';
import type { HotkeyCombo, MacroActionInstance } from './types.js';

export interface MacroSubgraph {
  nodes: GraphNodeDescriptor[];
  edges: GraphEdgeDescriptor[];
}

/** A `system_hotkey` node carrying the combo. */
export function buildHotkeyNode(
  shortcut: HotkeyCombo,
  makeId: () => string,
  position: { x: number; y: number } = { x: 0, y: 0 }
): GraphNodeDescriptor {
  return {
    id: makeId(),
    kind: 'system_hotkey',
    position,
    defaultConfig: {
      key: shortcut.key,
      ctrl: shortcut.ctrl,
      shift: shortcut.shift,
      alt: shortcut.alt,
      meta: shortcut.meta,
    },
  };
}

/** hotkey → action. */
export function assembleSingleMacro(
  shortcut: HotkeyCombo,
  action: MacroActionInstance,
  makeId: () => string
): MacroSubgraph {
  const def = macroActionById(action.defId);
  if (!def) throw new Error(`Unknown macro action: ${action.defId}`);
  const hotkey = buildHotkeyNode(shortcut, makeId);
  const built = def.build(action.values, makeId);
  return {
    nodes: [hotkey, ...built.nodes],
    edges: [
      {
        fromNodeId: hotkey.id,
        fromPort: 'event',
        toNodeId: built.entryNodeId,
        toPort: built.entryPort,
      },
      ...built.edges,
    ],
  };
}

/** hotkey → cycle(N) → [action per state]. `null` states leave that output
 *  unconnected (a "custom"/unset slot the user can fill later). */
export function assembleCycleMacro(
  shortcut: HotkeyCombo,
  states: ReadonlyArray<MacroActionInstance | null>,
  makeId: () => string
): MacroSubgraph {
  const hotkey = buildHotkeyNode(shortcut, makeId);
  const cycleId = makeId();
  const nodes: GraphNodeDescriptor[] = [
    hotkey,
    {
      id: cycleId,
      kind: 'cycle',
      position: { x: 0, y: 0 },
      defaultConfig: { count: states.length },
    },
  ];
  const edges: GraphEdgeDescriptor[] = [
    { fromNodeId: hotkey.id, fromPort: 'event', toNodeId: cycleId, toPort: 'in' },
  ];
  states.forEach((state, i) => {
    if (!state) return;
    const def = macroActionById(state.defId);
    if (!def) throw new Error(`Unknown macro action: ${state.defId}`);
    const built = def.build(state.values, makeId);
    nodes.push(...built.nodes);
    edges.push({
      fromNodeId: cycleId,
      fromPort: `out${i}`,
      toNodeId: built.entryNodeId,
      toPort: built.entryPort,
    });
    edges.push(...built.edges);
  });
  return { nodes, edges };
}
