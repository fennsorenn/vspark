import type { GraphDescriptor } from '@vspark/shared/signal'

export const BREATHING_PIPELINE_TEMPLATE: Omit<GraphDescriptor, 'id'> = {
  label:    'Breathing',
  readonly: true,
  nodes: [
    // ── Context ──────────────────────────────────────────────────────────────
    { id: 'scene_entity', kind: 'scene_entity', position: { x:  960, y: -120 } },
    { id: 'comp_id',      kind: 'component_id', position: { x:  960, y:  -40 } },

    // ── Tick: independent clock drives the broadcast (decoupled from tracking) ──
    { id: 'clock', kind: 'clock', position: { x: -300, y:    0 }, defaultConfig: { hz: 30 } },

    // ── Time (lazily evaluated on each pull) ─────────────────────────────────
    { id: 'time',  kind: 'time',  position: { x: -300, y:  260 } },

    // ── Bone name / mode literals ────────────────────────────────────────────
    { id: 'cfg_bone_chest', kind: 'component_config', position: { x: -300, y: 380 }, defaultConfig: { field: '_chest_bone', defaultValue: 'chest'    } },
    { id: 'cfg_bone_spine', kind: 'component_config', position: { x: -300, y: 480 }, defaultConfig: { field: '_spine_bone', defaultValue: 'spine'    } },
    { id: 'cfg_mode',       kind: 'component_config', position: { x: -300, y: 580 }, defaultConfig: { field: '_mode',       defaultValue: 'multiply' } },

    // ── Output config literals ───────────────────────────────────────────────
    { id: 'cfg_priority',   kind: 'component_config', position: { x: -300, y: 700 }, defaultConfig: { field: '_priority', defaultValue: 10 } },
    { id: 'cfg_blend_mode', kind: 'component_config', position: { x: -300, y: 820 }, defaultConfig: { field: '_blend',    defaultValue: 'additive' } },

    // ── Chest sine ───────────────────────────────────────────────────────────
    { id: 'sine_chest',    kind: 'sine_wave',           position: { x:  120, y:  100 }, defaultConfig: { frequency: 0.25, amplitude: 0.04, phase: 0   } },
    { id: 'euler_chest',   kind: 'euler_to_quaternion', position: { x:  360, y:  100 } },
    { id: 'apply_chest',   kind: 'pose_apply_bone',     position: { x:  600, y:  100 } },

    // ── Spine sine (slightly phase-delayed) ──────────────────────────────────
    { id: 'sine_spine',    kind: 'sine_wave',           position: { x:  120, y:  260 }, defaultConfig: { frequency: 0.25, amplitude: 0.02, phase: 0.4 } },
    { id: 'euler_spine',   kind: 'euler_to_quaternion', position: { x:  360, y:  260 } },
    { id: 'apply_spine',   kind: 'pose_apply_bone',     position: { x:  600, y:  260 } },

    // ── Bus producer ─────────────────────────────────────────────────────────
    { id: 'pose_out', kind: 'pose_broadcast', position: { x:  960, y:  180 } },
  ],
  edges: [
    // ── Event: clock → broadcast ─────────────────────────────────────────────
    { fromNodeId: 'clock', fromPort: 'tick', toNodeId: 'pose_out', toPort: 'trigger' },
    // ── Value: time → sines ──────────────────────────────────────────────────
    { fromNodeId: 'time',  fromPort: 'seconds', toNodeId: 'sine_chest', toPort: 'time', kind: 'value' },
    { fromNodeId: 'time',  fromPort: 'seconds', toNodeId: 'sine_spine', toPort: 'time', kind: 'value' },
    // ── Value: sines → euler pitch ────────────────────────────────────────────
    { fromNodeId: 'sine_chest', fromPort: 'value', toNodeId: 'euler_chest', toPort: 'pitch', kind: 'value' },
    { fromNodeId: 'sine_spine', fromPort: 'value', toNodeId: 'euler_spine', toPort: 'pitch', kind: 'value' },
    // ── Value: euler → apply quaternion ──────────────────────────────────────
    { fromNodeId: 'euler_chest', fromPort: 'quaternion', toNodeId: 'apply_chest', toPort: 'quaternion', kind: 'value' },
    { fromNodeId: 'euler_spine', fromPort: 'quaternion', toNodeId: 'apply_spine', toPort: 'quaternion', kind: 'value' },
    // ── Value: pose chain (apply_chest starts from empty pose) ──────────────
    { fromNodeId: 'apply_chest', fromPort: 'pose', toNodeId: 'apply_spine', toPort: 'pose', kind: 'value' },
    { fromNodeId: 'apply_spine', fromPort: 'pose', toNodeId: 'pose_out',    toPort: 'pose', kind: 'value' },
    // ── Value: bone names and mode ───────────────────────────────────────────
    { fromNodeId: 'cfg_bone_chest', fromPort: 'value', toNodeId: 'apply_chest', toPort: 'bone', kind: 'value' },
    { fromNodeId: 'cfg_bone_spine', fromPort: 'value', toNodeId: 'apply_spine', toPort: 'bone', kind: 'value' },
    { fromNodeId: 'cfg_mode',       fromPort: 'value', toNodeId: 'apply_chest', toPort: 'mode', kind: 'value' },
    { fromNodeId: 'cfg_mode',       fromPort: 'value', toNodeId: 'apply_spine', toPort: 'mode', kind: 'value' },
    // ── Value: broadcast identity + slot metadata ────────────────────────────
    { fromNodeId: 'scene_entity',   fromPort: 'nodeId', toNodeId: 'pose_out', toPort: 'nodeId',             kind: 'value' },
    { fromNodeId: 'comp_id',        fromPort: 'id',     toNodeId: 'pose_out', toPort: 'componentId',        kind: 'value' },
    { fromNodeId: 'cfg_priority',   fromPort: 'value',  toNodeId: 'pose_out', toPort: 'priority',           kind: 'value' },
    { fromNodeId: 'cfg_blend_mode', fromPort: 'value',  toNodeId: 'pose_out', toPort: 'animationBlendMode', kind: 'value' },
  ],
}

export function makeBreathingGraphDescriptor(componentId: string): GraphDescriptor {
  return { ...BREATHING_PIPELINE_TEMPLATE, id: `breathing:${componentId}` }
}
