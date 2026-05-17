import type { GraphDescriptor } from '@vspark/shared/signal'

export const LIPSYNC_PIPELINE_TEMPLATE: Omit<GraphDescriptor, 'id'> = {
  label:    'Lipsync',
  readonly: true,
  nodes: [
    // ── Config ──────────────────────────────────────────────────────────────
    { id: 'cfg_sensitivity', kind: 'component_config', position: { x: -280, y: 80 },
      defaultConfig: { field: 'sensitivity', defaultValue: 1.0 } },
    // ── Infrastructure ───────────────────────────────────────────────────────
    { id: 'comp_id',      kind: 'component_id',   position: { x: -280, y: -60 } },
    { id: 'scene_entity', kind: 'scene_entity',   position: { x:  640, y: -60 } },
    // ── Entry point (fired by LipsyncManager) ────────────────────────────────
    { id: 'lipsync_src',  kind: 'lipsync_source', position: { x: -280, y:   0 } },
    // ── Unpack event → trigger + value ──────────────────────────────────────
    { id: 'unpack',       kind: 'unpack_event',   position: { x:   60, y:   0 } },
    // ── Sensitivity scaling ──────────────────────────────────────────────────
    { id: 'passthrough',  kind: 'viseme_passthrough', position: { x:  340, y:   0 } },
    // ── Broadcast ────────────────────────────────────────────────────────────
    { id: 'bs_out',       kind: 'blendshapes_broadcast', position: { x:  640, y:   0 } },
  ],
  edges: [
    // Entry event → unpack
    { fromNodeId: 'lipsync_src', fromPort: 'visemes',     toNodeId: 'unpack',      toPort: 'event' },
    // Unpack trigger → broadcast
    { fromNodeId: 'unpack',      fromPort: 'trigger',     toNodeId: 'bs_out',      toPort: 'trigger' },
    // Unpack value → passthrough (event carrying Blendshapes)
    { fromNodeId: 'lipsync_src', fromPort: 'visemes',     toNodeId: 'passthrough', toPort: 'visemes' },
    // Passthrough output → broadcast
    { fromNodeId: 'passthrough', fromPort: 'blendshapes', toNodeId: 'bs_out',      toPort: 'blendshapes', kind: 'value' },
    // Config → passthrough
    { fromNodeId: 'cfg_sensitivity', fromPort: 'value',   toNodeId: 'passthrough', toPort: 'blendshapes', kind: 'value' },
    // Scene entity → broadcast
    { fromNodeId: 'scene_entity', fromPort: 'nodeId',     toNodeId: 'bs_out',      toPort: 'nodeId',      kind: 'value' },
  ],
}

export function makeLipsyncGraphDescriptor(componentId: string): GraphDescriptor {
  return { ...LIPSYNC_PIPELINE_TEMPLATE, id: `lipsync:${componentId}` }
}
