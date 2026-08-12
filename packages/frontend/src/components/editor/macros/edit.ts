/**
 * Macro descriptor edits — pure transforms the Macros panel applies to a logic
 * `GraphDescriptor` before persisting it (the UI → graph write side).
 *
 * All functions are pure and return a NEW descriptor; the panel/hook owns the
 * PUT. Kept separate from build.ts (which assembles fresh subgraphs) so the
 * mutation logic is unit-testable without the store.
 */

import type {
  GraphDescriptor,
  GraphEdgeDescriptor,
} from '@vspark/shared/signal';
import type { MacroActionInstance } from './types.js';
import { macroActionById } from './actionRegistry.js';
import type { MacroSubgraph } from './build.js';

/** Append nodes + edges to a descriptor. */
export function insertSubgraph(
  d: GraphDescriptor,
  sub: MacroSubgraph
): GraphDescriptor {
  return { ...d, nodes: [...d.nodes, ...sub.nodes], edges: [...d.edges, ...sub.edges] };
}

/** Remove a set of node ids and every edge touching them. */
export function removeNodes(
  d: GraphDescriptor,
  ids: ReadonlySet<string>
): GraphDescriptor {
  return {
    ...d,
    nodes: d.nodes.filter((n) => !ids.has(n.id)),
    edges: d.edges.filter((e) => !ids.has(e.fromNodeId) && !ids.has(e.toNodeId)),
  };
}

/** Nodes reachable from `startId` following outgoing edges (excludes start). */
export function reachableFrom(
  d: GraphDescriptor,
  startId: string
): Set<string> {
  const out = new Set<string>();
  const stack = [startId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of d.edges) {
      if (e.fromNodeId === cur && !out.has(e.toNodeId)) {
        out.add(e.toNodeId);
        stack.push(e.toNodeId);
      }
    }
  }
  out.delete(startId);
  return out;
}

/**
 * The set of nodes a macro exclusively owns: the hotkey plus every node
 * reachable from it whose inbound edges ALL originate inside the reachable set.
 * A downstream node that's also driven from outside the macro is left in place
 * (defensive against hand-wired sharing on the canvas).
 */
function macroOwnedNodes(d: GraphDescriptor, hotkeyId: string): Set<string> {
  const reach = reachableFrom(d, hotkeyId);
  const inSet = new Set<string>([hotkeyId, ...reach]);
  const owned = new Set<string>([hotkeyId]);
  for (const id of reach) {
    const inboundOk = d.edges
      .filter((e) => e.toNodeId === id)
      .every((e) => inSet.has(e.fromNodeId));
    if (inboundOk) owned.add(id);
  }
  return owned;
}

/** Remove a whole macro (its hotkey + exclusively-owned downstream nodes). */
export function removeMacro(
  d: GraphDescriptor,
  hotkeyId: string
): GraphDescriptor {
  return removeNodes(d, macroOwnedNodes(d, hotkeyId));
}

/** Shallow-merge a patch into a node's defaultConfig. */
export function patchNodeConfig(
  d: GraphDescriptor,
  nodeId: string,
  patch: Record<string, unknown>
): GraphDescriptor {
  return {
    ...d,
    nodes: d.nodes.map((n) =>
      n.id === nodeId
        ? { ...n, defaultConfig: { ...(n.defaultConfig ?? {}), ...patch } }
        : n
    ),
  };
}

/**
 * Replace a single-action macro's action: drop the hotkey's current downstream
 * (keeping the hotkey), then build + wire the new action from `hotkey.event`.
 * Pass `null` to just clear the action (leaves a triggerless hotkey).
 */
export function setSingleAction(
  d: GraphDescriptor,
  hotkeyId: string,
  action: MacroActionInstance | null,
  makeId: () => string
): GraphDescriptor {
  // Remove everything downstream of the hotkey, keep the hotkey node itself.
  const owned = macroOwnedNodes(d, hotkeyId);
  owned.delete(hotkeyId);
  let next = removeNodes(d, owned);
  if (!action) return next;

  const def = macroActionById(action.defId);
  if (!def) throw new Error(`Unknown macro action: ${action.defId}`);
  const built = def.build(action.values, makeId);
  const wire: GraphEdgeDescriptor = {
    fromNodeId: hotkeyId,
    fromPort: 'event',
    toNodeId: built.entryNodeId,
    toPort: built.entryPort,
  };
  next = insertSubgraph(next, {
    nodes: built.nodes,
    edges: [wire, ...built.edges],
  });
  return next;
}
