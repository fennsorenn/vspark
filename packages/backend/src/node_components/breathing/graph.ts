import type { GraphDescriptor } from '@vspark/shared/signal'

export const BREATHING_PIPELINE_TEMPLATE: Omit<GraphDescriptor, 'id'> = {
  label:    'Breathing',
  readonly: true,
  nodes: [
    // ── Interceptor entry / exit ─────────────────────────────────────────────
    { id: 'on_broadcast',  kind: 'on_pose_broadcast',          position: { x: -300, y:    0 }, defaultConfig: { priority: 10 } },
    { id: 'broadcast_out', kind: 'pose_interceptor_broadcast', position: { x:  960, y:    0 } },
    // ── Time (lazily evaluated on each pull) ──────────────────────────────────
    { id: 'time',          kind: 'time',                       position: { x: -300, y:  260 } },
    // ── Bone name / mode literals ─────────────────────────────────────────────
    { id: 'cfg_bone_chest', kind: 'component_config', position: { x: -300, y: 380 }, defaultConfig: { field: '_chest_bone', defaultValue: 'chest'    } },
    { id: 'cfg_bone_spine', kind: 'component_config', position: { x: -300, y: 480 }, defaultConfig: { field: '_spine_bone', defaultValue: 'spine'    } },
    { id: 'cfg_mode',       kind: 'component_config', position: { x: -300, y: 580 }, defaultConfig: { field: '_mode',       defaultValue: 'multiply' } },
    // ── Chest sine ───────────────────────────────────────────────────────────
    { id: 'sine_chest',    kind: 'sine_wave',          position: { x:  120, y:  100 }, defaultConfig: { frequency: 0.25, amplitude: 0.04, phase: 0   } },
    { id: 'euler_chest',   kind: 'euler_to_quaternion', position: { x:  360, y:  100 } },
    { id: 'apply_chest',   kind: 'pose_apply_bone',    position: { x:  600, y:  100 } },
    // ── Spine sine (slightly phase-delayed) ──────────────────────────────────
    { id: 'sine_spine',    kind: 'sine_wave',          position: { x:  120, y:  260 }, defaultConfig: { frequency: 0.25, amplitude: 0.02, phase: 0.4 } },
    { id: 'euler_spine',   kind: 'euler_to_quaternion', position: { x:  360, y:  260 } },
    { id: 'apply_spine',   kind: 'pose_apply_bone',    position: { x:  600, y:  260 } },
  ],
  edges: [
    // ── Event: on_broadcast trigger drives broadcast_out ─────────────────────
    { fromNodeId: 'on_broadcast', fromPort: 'trigger',    toNodeId: 'broadcast_out', toPort: 'trigger' },
    // ── Value: time → sines ──────────────────────────────────────────────────
    { fromNodeId: 'time',         fromPort: 'seconds',    toNodeId: 'sine_chest',    toPort: 'time',       kind: 'value' },
    { fromNodeId: 'time',         fromPort: 'seconds',    toNodeId: 'sine_spine',    toPort: 'time',       kind: 'value' },
    // ── Value: sines → euler pitch ────────────────────────────────────────────
    { fromNodeId: 'sine_chest',   fromPort: 'value',      toNodeId: 'euler_chest',   toPort: 'pitch',      kind: 'value' },
    { fromNodeId: 'sine_spine',   fromPort: 'value',      toNodeId: 'euler_spine',   toPort: 'pitch',      kind: 'value' },
    // ── Value: euler → apply quaternion ──────────────────────────────────────
    { fromNodeId: 'euler_chest',  fromPort: 'quaternion', toNodeId: 'apply_chest',   toPort: 'quaternion', kind: 'value' },
    { fromNodeId: 'euler_spine',  fromPort: 'quaternion', toNodeId: 'apply_spine',   toPort: 'quaternion', kind: 'value' },
    // ── Value: pose chain ────────────────────────────────────────────────────
    { fromNodeId: 'on_broadcast', fromPort: 'pose',       toNodeId: 'apply_chest',   toPort: 'pose',       kind: 'value' },
    { fromNodeId: 'apply_chest',  fromPort: 'pose',       toNodeId: 'apply_spine',   toPort: 'pose',       kind: 'value' },
    { fromNodeId: 'apply_spine',  fromPort: 'pose',       toNodeId: 'broadcast_out', toPort: 'pose',       kind: 'value' },
    // ── Value: frame passthrough ─────────────────────────────────────────────
    { fromNodeId: 'on_broadcast', fromPort: 'frame',      toNodeId: 'broadcast_out', toPort: 'frame',      kind: 'value' },
    // ── Value: bone names and mode ────────────────────────────────────────────
    { fromNodeId: 'cfg_bone_chest', fromPort: 'value',    toNodeId: 'apply_chest',   toPort: 'bone',       kind: 'value' },
    { fromNodeId: 'cfg_bone_spine', fromPort: 'value',    toNodeId: 'apply_spine',   toPort: 'bone',       kind: 'value' },
    { fromNodeId: 'cfg_mode',       fromPort: 'value',    toNodeId: 'apply_chest',   toPort: 'mode',       kind: 'value' },
    { fromNodeId: 'cfg_mode',       fromPort: 'value',    toNodeId: 'apply_spine',   toPort: 'mode',       kind: 'value' },
  ],
}

export function makeBreathingGraphDescriptor(componentId: string): GraphDescriptor {
  return { ...BREATHING_PIPELINE_TEMPLATE, id: `breathing:${componentId}` }
}
