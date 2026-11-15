import type { GraphDescriptor } from '@vspark/shared/signal';

/**
 * API Controller graph: the blendshapes set over REST / MCP enter at
 * `api_src` (fired by ApiControllerManager) and leave through
 * `blendshapes_broadcast` under this behavior's id, so the Tracking Mix and
 * the graph editor see the API Controller like any other source.
 *
 * Animation queueing is not part of the graph: it writes the avatar's
 * `scheduled_animation` timeline, which the frontend plays (no bus output).
 */
export const API_CONTROLLER_TEMPLATE: Omit<GraphDescriptor, 'id'> = {
  label: 'API Controller',
  readonly: false,
  nodes: [
    { id: 'comp_id', kind: 'behavior_id', position: { x: -280, y: -60 } },
    { id: 'scene_entity', kind: 'scene_entity', position: { x: 340, y: -60 } },
    // ── Entry point (fired by ApiControllerManager) ──────────────────────────
    {
      id: 'api_src',
      kind: 'api_controller_source',
      position: { x: -280, y: 0 },
    },
    { id: 'unpack', kind: 'unpack_event', position: { x: 40, y: 0 } },
    // ── Broadcast ────────────────────────────────────────────────────────────
    { id: 'bs_out', kind: 'blendshapes_broadcast', position: { x: 340, y: 0 } },
  ],
  edges: [
    {
      fromNodeId: 'api_src',
      fromPort: 'blendshapes',
      toNodeId: 'unpack',
      toPort: 'event',
    },
    {
      fromNodeId: 'unpack',
      fromPort: 'trigger',
      toNodeId: 'bs_out',
      toPort: 'trigger',
    },
    {
      fromNodeId: 'unpack',
      fromPort: 'value',
      toNodeId: 'bs_out',
      toPort: 'blendshapes',
      kind: 'value',
    },
    {
      fromNodeId: 'scene_entity',
      fromPort: 'nodeId',
      toNodeId: 'bs_out',
      toPort: 'nodeId',
      kind: 'value',
    },
    {
      fromNodeId: 'comp_id',
      fromPort: 'id',
      toNodeId: 'bs_out',
      toPort: 'behaviorId',
      kind: 'value',
    },
  ],
};
