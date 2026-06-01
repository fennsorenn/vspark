import type { GraphDescriptor } from '@vspark/shared/signal';

/**
 * Breathing pipeline.
 *
 * Two sine oscillators (chest / shoulder amplitudes, both user-configurable)
 * drive a 6-bone pose:
 *
 *   chest        = +chestAmp pitch
 *   upperChest   = −chestAmp pitch     (counter-rotates so the head stays put)
 *   leftShoulder = +shoulderAmp roll   (lifts on inhale)
 *   rightShoulder= −shoulderAmp roll   (mirrored)
 *   leftUpperArm = −shoulderAmp roll   (cancels the clavicle lift on the arm)
 *   rightUpperArm= +shoulderAmp roll
 *
 * The pose is published additively at priority 10 so it composes on top of
 * the animation clip rather than replacing it.
 */
export const BREATHING_PIPELINE_TEMPLATE: Omit<GraphDescriptor, 'id'> = {
  label: 'Breathing',
  readonly: true,
  nodes: [
    // ── Context ──────────────────────────────────────────────────────────────
    { id: 'scene_entity', kind: 'scene_entity', position: { x: 960, y: -120 } },
    { id: 'comp_id', kind: 'component_id', position: { x: 960, y: -40 } },

    // ── Tick ─────────────────────────────────────────────────────────────────
    {
      id: 'clock',
      kind: 'clock',
      position: { x: -300, y: 0 },
      defaultConfig: { hz: 30 },
    },

    // ── Time ─────────────────────────────────────────────────────────────────
    { id: 'time', kind: 'time', position: { x: -300, y: 100 } },

    // ── Configurable amplitudes ──────────────────────────────────────────────
    {
      id: 'cfg_chest_amp',
      kind: 'component_config',
      position: { x: -300, y: 220 },
      defaultConfig: { field: 'chestAmplitude', defaultValue: 0.04 },
    },
    {
      id: 'cfg_shoulder_amp',
      kind: 'component_config',
      position: { x: -300, y: 300 },
      defaultConfig: { field: 'shoulderAmplitude', defaultValue: 0.02 },
    },

    // ── Negators (×-1) for the counter-rotated bones ─────────────────────────
    {
      id: 'neg_chest',
      kind: 'multiply',
      position: { x: -60, y: 220 },
      defaultConfig: { b: -1 },
    },
    {
      id: 'neg_shoulder',
      kind: 'multiply',
      position: { x: -60, y: 300 },
      defaultConfig: { b: -1 },
    },

    // ── Chest / upper-chest sines (pitch) ────────────────────────────────────
    {
      id: 'sine_chest',
      kind: 'sine_wave',
      position: { x: 120, y: 60 },
      defaultConfig: { frequency: 0.25, phase: 0 },
    },
    {
      id: 'euler_chest',
      kind: 'euler_to_quaternion',
      position: { x: 360, y: 60 },
    },
    {
      id: 'apply_chest',
      kind: 'pose_apply_bone',
      position: { x: 600, y: 60 },
      defaultConfig: { bone: 'chest', mode: 'multiply' },
    },

    {
      id: 'sine_upper_chest',
      kind: 'sine_wave',
      position: { x: 120, y: 160 },
      defaultConfig: { frequency: 0.25, phase: 0 },
    },
    {
      id: 'euler_upper_chest',
      kind: 'euler_to_quaternion',
      position: { x: 360, y: 160 },
    },
    {
      id: 'apply_upper_chest',
      kind: 'pose_apply_bone',
      position: { x: 600, y: 160 },
      defaultConfig: { bone: 'upperChest', mode: 'multiply' },
    },

    // ── Shoulder lift sines (roll) ───────────────────────────────────────────
    {
      id: 'sine_l_shoulder',
      kind: 'sine_wave',
      position: { x: 120, y: 320 },
      defaultConfig: { frequency: 0.25, phase: 0 },
    },
    {
      id: 'euler_l_shoulder',
      kind: 'euler_to_quaternion',
      position: { x: 360, y: 320 },
    },
    {
      id: 'apply_l_shoulder',
      kind: 'pose_apply_bone',
      position: { x: 600, y: 320 },
      defaultConfig: { bone: 'leftShoulder', mode: 'multiply' },
    },

    {
      id: 'sine_r_shoulder',
      kind: 'sine_wave',
      position: { x: 120, y: 400 },
      defaultConfig: { frequency: 0.25, phase: 0 },
    },
    {
      id: 'euler_r_shoulder',
      kind: 'euler_to_quaternion',
      position: { x: 360, y: 400 },
    },
    {
      id: 'apply_r_shoulder',
      kind: 'pose_apply_bone',
      position: { x: 600, y: 400 },
      defaultConfig: { bone: 'rightShoulder', mode: 'multiply' },
    },

    // ── Upper-arm counter-rotation (cancels clavicle lift on the arm) ───────
    {
      id: 'sine_l_upper_arm',
      kind: 'sine_wave',
      position: { x: 120, y: 500 },
      defaultConfig: { frequency: 0.25, phase: 0 },
    },
    {
      id: 'euler_l_upper_arm',
      kind: 'euler_to_quaternion',
      position: { x: 360, y: 500 },
    },
    {
      id: 'apply_l_upper_arm',
      kind: 'pose_apply_bone',
      position: { x: 600, y: 500 },
      defaultConfig: { bone: 'leftUpperArm', mode: 'multiply' },
    },

    {
      id: 'sine_r_upper_arm',
      kind: 'sine_wave',
      position: { x: 120, y: 580 },
      defaultConfig: { frequency: 0.25, phase: 0 },
    },
    {
      id: 'euler_r_upper_arm',
      kind: 'euler_to_quaternion',
      position: { x: 360, y: 580 },
    },
    {
      id: 'apply_r_upper_arm',
      kind: 'pose_apply_bone',
      position: { x: 600, y: 580 },
      defaultConfig: { bone: 'rightUpperArm', mode: 'multiply' },
    },

    // ── Bus producer ─────────────────────────────────────────────────────────
    {
      id: 'pose_out',
      kind: 'pose_broadcast',
      position: { x: 960, y: 320 },
      defaultConfig: { priority: 10, animationBlendMode: 'additive' },
    },
  ],
  edges: [
    // ── Event: clock → broadcast ─────────────────────────────────────────────
    {
      fromNodeId: 'clock',
      fromPort: 'tick',
      toNodeId: 'pose_out',
      toPort: 'trigger',
    },

    // ── Amplitude routing ────────────────────────────────────────────────────
    // chestAmp:       +chest, neg → upperChest
    {
      fromNodeId: 'cfg_chest_amp',
      fromPort: 'value',
      toNodeId: 'sine_chest',
      toPort: 'amplitude',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_chest_amp',
      fromPort: 'value',
      toNodeId: 'neg_chest',
      toPort: 'a',
      kind: 'value',
    },
    {
      fromNodeId: 'neg_chest',
      fromPort: 'value',
      toNodeId: 'sine_upper_chest',
      toPort: 'amplitude',
      kind: 'value',
    },
    // shoulderAmp:    +leftShoulder, +rightUpperArm; neg → rightShoulder, leftUpperArm
    {
      fromNodeId: 'cfg_shoulder_amp',
      fromPort: 'value',
      toNodeId: 'sine_l_shoulder',
      toPort: 'amplitude',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_shoulder_amp',
      fromPort: 'value',
      toNodeId: 'sine_r_upper_arm',
      toPort: 'amplitude',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_shoulder_amp',
      fromPort: 'value',
      toNodeId: 'neg_shoulder',
      toPort: 'a',
      kind: 'value',
    },
    {
      fromNodeId: 'neg_shoulder',
      fromPort: 'value',
      toNodeId: 'sine_r_shoulder',
      toPort: 'amplitude',
      kind: 'value',
    },
    {
      fromNodeId: 'neg_shoulder',
      fromPort: 'value',
      toNodeId: 'sine_l_upper_arm',
      toPort: 'amplitude',
      kind: 'value',
    },

    // ── time → sines ─────────────────────────────────────────────────────────
    {
      fromNodeId: 'time',
      fromPort: 'seconds',
      toNodeId: 'sine_chest',
      toPort: 'time',
      kind: 'value',
    },
    {
      fromNodeId: 'time',
      fromPort: 'seconds',
      toNodeId: 'sine_upper_chest',
      toPort: 'time',
      kind: 'value',
    },
    {
      fromNodeId: 'time',
      fromPort: 'seconds',
      toNodeId: 'sine_l_shoulder',
      toPort: 'time',
      kind: 'value',
    },
    {
      fromNodeId: 'time',
      fromPort: 'seconds',
      toNodeId: 'sine_r_shoulder',
      toPort: 'time',
      kind: 'value',
    },
    {
      fromNodeId: 'time',
      fromPort: 'seconds',
      toNodeId: 'sine_l_upper_arm',
      toPort: 'time',
      kind: 'value',
    },
    {
      fromNodeId: 'time',
      fromPort: 'seconds',
      toNodeId: 'sine_r_upper_arm',
      toPort: 'time',
      kind: 'value',
    },

    // ── chest sines → euler pitch ────────────────────────────────────────────
    {
      fromNodeId: 'sine_chest',
      fromPort: 'value',
      toNodeId: 'euler_chest',
      toPort: 'pitch',
      kind: 'value',
    },
    {
      fromNodeId: 'sine_upper_chest',
      fromPort: 'value',
      toNodeId: 'euler_upper_chest',
      toPort: 'pitch',
      kind: 'value',
    },
    // ── shoulder/arm sines → euler roll (Z-axis) ────────────────────────────
    {
      fromNodeId: 'sine_l_shoulder',
      fromPort: 'value',
      toNodeId: 'euler_l_shoulder',
      toPort: 'roll',
      kind: 'value',
    },
    {
      fromNodeId: 'sine_r_shoulder',
      fromPort: 'value',
      toNodeId: 'euler_r_shoulder',
      toPort: 'roll',
      kind: 'value',
    },
    {
      fromNodeId: 'sine_l_upper_arm',
      fromPort: 'value',
      toNodeId: 'euler_l_upper_arm',
      toPort: 'roll',
      kind: 'value',
    },
    {
      fromNodeId: 'sine_r_upper_arm',
      fromPort: 'value',
      toNodeId: 'euler_r_upper_arm',
      toPort: 'roll',
      kind: 'value',
    },

    // ── euler → apply quaternion ─────────────────────────────────────────────
    {
      fromNodeId: 'euler_chest',
      fromPort: 'quaternion',
      toNodeId: 'apply_chest',
      toPort: 'quaternion',
      kind: 'value',
    },
    {
      fromNodeId: 'euler_upper_chest',
      fromPort: 'quaternion',
      toNodeId: 'apply_upper_chest',
      toPort: 'quaternion',
      kind: 'value',
    },
    {
      fromNodeId: 'euler_l_shoulder',
      fromPort: 'quaternion',
      toNodeId: 'apply_l_shoulder',
      toPort: 'quaternion',
      kind: 'value',
    },
    {
      fromNodeId: 'euler_r_shoulder',
      fromPort: 'quaternion',
      toNodeId: 'apply_r_shoulder',
      toPort: 'quaternion',
      kind: 'value',
    },
    {
      fromNodeId: 'euler_l_upper_arm',
      fromPort: 'quaternion',
      toNodeId: 'apply_l_upper_arm',
      toPort: 'quaternion',
      kind: 'value',
    },
    {
      fromNodeId: 'euler_r_upper_arm',
      fromPort: 'quaternion',
      toNodeId: 'apply_r_upper_arm',
      toPort: 'quaternion',
      kind: 'value',
    },

    // ── pose chain (apply_chest starts from empty pose) ─────────────────────
    {
      fromNodeId: 'apply_chest',
      fromPort: 'pose',
      toNodeId: 'apply_upper_chest',
      toPort: 'pose',
      kind: 'value',
    },
    {
      fromNodeId: 'apply_upper_chest',
      fromPort: 'pose',
      toNodeId: 'apply_l_shoulder',
      toPort: 'pose',
      kind: 'value',
    },
    {
      fromNodeId: 'apply_l_shoulder',
      fromPort: 'pose',
      toNodeId: 'apply_r_shoulder',
      toPort: 'pose',
      kind: 'value',
    },
    {
      fromNodeId: 'apply_r_shoulder',
      fromPort: 'pose',
      toNodeId: 'apply_l_upper_arm',
      toPort: 'pose',
      kind: 'value',
    },
    {
      fromNodeId: 'apply_l_upper_arm',
      fromPort: 'pose',
      toNodeId: 'apply_r_upper_arm',
      toPort: 'pose',
      kind: 'value',
    },
    {
      fromNodeId: 'apply_r_upper_arm',
      fromPort: 'pose',
      toNodeId: 'pose_out',
      toPort: 'pose',
      kind: 'value',
    },

    // ── Slot identity ────────────────────────────────────────────────────────
    {
      fromNodeId: 'scene_entity',
      fromPort: 'nodeId',
      toNodeId: 'pose_out',
      toPort: 'nodeId',
      kind: 'value',
    },
    {
      fromNodeId: 'comp_id',
      fromPort: 'id',
      toNodeId: 'pose_out',
      toPort: 'componentId',
      kind: 'value',
    },
  ],
};

export function makeBreathingGraphDescriptor(
  componentId: string
): GraphDescriptor {
  return { ...BREATHING_PIPELINE_TEMPLATE, id: `breathing:${componentId}` };
}
