/**
 * Macro projection — DERIVE macro rows from logic graph descriptors.
 *
 * The macro panel stores nothing; it renders whatever this pure function reads
 * out of the descriptors, so canvas edits and macro-panel edits stay in sync by
 * construction (see dev-notes/plans/macro-ui.md).
 *
 * The projection is TOTAL and CONSERVATIVE: every `system_hotkey` node becomes
 * exactly one row, and a row is either fully MODELED (`single` / `cycle`, with
 * a lossless action read-back) or OPAQUE (`empty` / `opaque`) — never silently
 * dropped or mis-read. Anything the classifier isn't certain it can round-trip
 * degrades to `opaque` rather than a wrong `single`.
 */

import type { GraphDescriptor, GraphNodeDescriptor } from '@vspark/shared/signal';
import { macroActionForNode } from './actionRegistry.js';
import type {
  HotkeyCombo,
  MacroActionInstance,
  MacroRow,
} from './types.js';

const HOTKEY_KIND = 'system_hotkey';
const CYCLE_KIND = 'cycle';

function readCombo(node: GraphNodeDescriptor): HotkeyCombo {
  const cfg = node.defaultConfig ?? {};
  return {
    key: typeof cfg['key'] === 'string' ? (cfg['key'] as string) : '',
    ctrl: Boolean(cfg['ctrl']),
    shift: Boolean(cfg['shift']),
    alt: Boolean(cfg['alt']),
    meta: Boolean(cfg['meta']),
  };
}

function cycleCount(node: GraphNodeDescriptor): number {
  const raw = Math.floor(Number((node.defaultConfig ?? {})['count'] ?? 2));
  return Number.isFinite(raw) && raw >= 2 ? raw : 2;
}

/** Edges leaving a node's output port. */
function edgesFrom(d: GraphDescriptor, nodeId: string, port: string) {
  return d.edges.filter((e) => e.fromNodeId === nodeId && e.fromPort === port);
}

/** Read a sink node (entered through `entryPort`) back into an action, or null. */
function matchAction(
  node: GraphNodeDescriptor,
  entryPort: string,
  d: GraphDescriptor
): MacroActionInstance | null {
  const def = macroActionForNode(node.kind, entryPort);
  if (!def) return null;
  const values = def.match(node, d);
  if (!values) return null;
  return { defId: def.id, values };
}

/** Classify one `system_hotkey` node's downstream chain into a macro row. */
export function classifyHotkey(
  hotkey: GraphNodeDescriptor,
  logicId: string,
  d: GraphDescriptor
): MacroRow {
  const base = {
    logicId,
    hotkeyNodeId: hotkey.id,
    shortcut: readCombo(hotkey),
    enabled: (hotkey.defaultConfig ?? {})['enabled'] !== false,
  };

  const outs = edgesFrom(d, hotkey.id, 'event');
  if (outs.length === 0) return { ...base, kind: 'empty' };
  // Fan-out from the raw hotkey event = more than one action → not modeled here.
  if (outs.length > 1) return { ...base, kind: 'opaque' };

  const edge = outs[0];
  const target = d.nodes.find((n) => n.id === edge.toNodeId);
  if (!target) return { ...base, kind: 'opaque' };

  // Toggle / multi-state: hotkey → cycle → [action per output].
  if (target.kind === CYCLE_KIND && edge.toPort === 'in') {
    const n = cycleCount(target);
    const states: (MacroActionInstance | null)[] = [];
    for (let i = 0; i < n; i++) {
      const branch = edgesFrom(d, target.id, `out${i}`);
      if (branch.length !== 1) {
        states.push(null); // unset or fan-out → this state is "custom"
        continue;
      }
      const sink = d.nodes.find((x) => x.id === branch[0].toNodeId);
      states.push(sink ? matchAction(sink, branch[0].toPort, d) : null);
    }
    return { ...base, kind: 'cycle', states };
  }

  // Single action directly on the hotkey event.
  const action = matchAction(target, edge.toPort, d);
  if (!action) return { ...base, kind: 'opaque' };
  return { ...base, kind: 'single', action };
}

/** Project every `system_hotkey` in a set of logic graphs into macro rows.
 *
 *  Defensive by construction: a malformed descriptor, or a single hotkey that
 *  somehow throws during classification, must never crash the panel — the worst
 *  outcome is that one row is dropped, because the macro view is a *derived*
 *  read over whatever the logic graphs currently contain. */
export function projectMacros(
  graphs: ReadonlyArray<{ logicId: string; descriptor: GraphDescriptor }>
): MacroRow[] {
  const rows: MacroRow[] = [];
  for (const { logicId, descriptor } of graphs) {
    const nodes = Array.isArray(descriptor?.nodes) ? descriptor.nodes : [];
    const safeDescriptor: GraphDescriptor = {
      id: descriptor?.id ?? logicId,
      label: descriptor?.label ?? '',
      readonly: descriptor?.readonly ?? false,
      nodes,
      edges: Array.isArray(descriptor?.edges) ? descriptor.edges : [],
    };
    for (const node of nodes) {
      if (node?.kind !== HOTKEY_KIND) continue;
      try {
        rows.push(classifyHotkey(node, logicId, safeDescriptor));
      } catch (err) {
        console.error('[macros] failed to classify a hotkey node', node?.id, err);
      }
    }
  }
  return rows;
}
