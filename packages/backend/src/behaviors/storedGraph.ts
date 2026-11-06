/**
 * What a behavior manager runs: the behavior's STORED graph (a `logic` row
 * with owner_kind 'behavior', migration 047), falling back to the kind's
 * template when none is stored or the stored one cannot be built.
 *
 * Read from SQLite, like the behavior rows the managers already sync from:
 * the persistence tap writes the row before any side effect runs, so a
 * manager refreshed from a tap sees the committed graph.
 *
 * Shared by every behavior manager so they agree on three things: where the
 * graph comes from, when a running graph is stale (`programChanged` — node
 * positions don't count), and which context a node gets injected
 * (`behaviorContextConfig` — by node KIND, so a `scene_entity`, `behavior_id`
 * or `settings` node the user adds on the canvas works like the template's).
 */
import { getDb } from '../db/index.js';
import {
  toGraphDescriptor,
  type GraphDescriptor,
  type GraphDescriptorDoc,
} from '@vspark/shared/signal';
import { graphFingerprint } from '@vspark/shared/actions';
import { NODE_REGISTRY } from '../signal/registry.js';
import { behaviorGraphId, behaviorTemplateGraph } from './templates.js';

/**
 * Reject a behavior graph that cannot run: an unknown node kind (the engine
 * refuses to build it) or an edge to a node that does not exist. The
 * behavior-context nodes Logic forbids (`settings`, `behavior_id`,
 * `scene_entity`) are fine here — behavior managers feed them.
 *
 * Nodes that only do something inside Logic (chat / hotkey / OBS / trigger
 * event sources, which LogicManager routes) are NOT rejected: they build and
 * run, they just never receive an event in a behavior graph.
 */
export function validateBehaviorGraph(d: GraphDescriptor): void {
  const ids = new Set<string>();
  for (const n of d.nodes) {
    if (!NODE_REGISTRY.has(n.kind))
      throw new Error(`Behavior graph uses unknown node kind "${n.kind}".`);
    ids.add(n.id);
  }
  for (const e of d.edges)
    if (!ids.has(e.fromNodeId) || !ids.has(e.toNodeId))
      throw new Error(
        `Behavior graph edge ${e.fromNodeId}.${e.fromPort} → ` +
          `${e.toNodeId}.${e.toPort} references a missing node.`
      );
}

/** The stored graph of a behavior (runtime form), if any. */
export function storedBehaviorGraph(
  behaviorId: string
): { id: string; name: string; descriptor: GraphDescriptor } | null {
  const row = getDb()
    .prepare(
      "SELECT id, name, descriptor FROM logic WHERE owner_kind = 'behavior' AND owner_id = ? ORDER BY created_at LIMIT 1"
    )
    .get(behaviorId) as
    | { id: string; name: string; descriptor: string }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    descriptor: toGraphDescriptor(
      JSON.parse(row.descriptor || '{}') as GraphDescriptorDoc
    ),
  };
}

/** The descriptor a manager should run for a behavior. Its id is always the
 *  behavior's runtime graph id (e.g. `vmc-pipeline:<id>`). */
export function behaviorDescriptorToRun(
  kind: string,
  behaviorId: string,
  config: unknown
): GraphDescriptor {
  const id = behaviorGraphId(kind, behaviorId);
  try {
    const stored = storedBehaviorGraph(behaviorId);
    if (stored) {
      validateBehaviorGraph(stored.descriptor);
      return {
        ...stored.descriptor,
        id,
        label: stored.name || stored.descriptor.label,
        readonly: false,
      };
    }
  } catch (e) {
    console.error(
      `[Behaviors] stored graph of ${behaviorId} cannot run, using the template:`,
      e
    );
  }
  return (
    behaviorTemplateGraph(kind, behaviorId, config) ?? {
      id,
      label: kind,
      readonly: false,
      nodes: [],
      edges: [],
    }
  );
}

const fpCache = new WeakMap<GraphDescriptor, string>();
const fpOf = (d: GraphDescriptor): string => {
  let fp = fpCache.get(d);
  if (fp === undefined) fpCache.set(d, (fp = graphFingerprint(d)));
  return fp;
};

/** Does `next` run differently from the `running` descriptor? Structure only:
 *  moving nodes on the canvas does not rebuild (and reset) a running graph. */
export function programChanged(
  running: GraphDescriptor | undefined,
  next: GraphDescriptor
): boolean {
  return !running || fpOf(running) !== fpOf(next);
}

/** Config a node gets from the behavior it runs in, by node kind:
 *  `scene_entity` → the behavior's scene node, `behavior_id` → the behavior,
 *  `settings` → the behavior's live config (`_settings`). Merge it over the
 *  node's own config. */
export function behaviorContextConfig(
  kind: string | undefined,
  ctx: {
    behaviorId: string;
    sceneNodeId: string;
    settings: Record<string, unknown>;
  }
): Record<string, unknown> {
  switch (kind) {
    case 'scene_entity':
      return { nodeId: ctx.sceneNodeId };
    case 'behavior_id':
      return { behaviorId: ctx.behaviorId };
    case 'settings':
      return { _settings: ctx.settings };
    default:
      return {};
  }
}
