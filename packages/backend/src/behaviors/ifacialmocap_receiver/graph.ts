import type { GraphDescriptor } from '@vspark/shared/signal';

/**
 * VRM bone names scoped to the head calibration stage.
 *
 * Deliberately narrower than the VMC receiver's `HEAD_CALIB_BONES`: iFacialMocap
 * is a face-only source, so hips/spine/chest never carry data and listing them
 * would let a capture store meaningless offsets.
 */
export const HEAD_CALIB_BONES = ['head', 'leftEye', 'rightEye'] as const;

/**
 * The iFacialMocap pipeline. Structurally the VMC pipeline with the body half
 * removed:
 *
 *   - same `unpack_event` → `rhylive_bone_mapper` → `body_calibration` →
 *     `pose_broadcast` bone chain (the manager hands the mapper Unity
 *     HumanBodyBones-keyed quaternions, exactly like the VMC receiver does)
 *   - same `arkit_vrm_mapper` ×3 → `blendshapes_sum` → `blendshapes_broadcast`
 *     face chain, with the same three config pairs
 *   - **no** `arm_ik_calibration` stage and no arm capture triggers — the phone
 *     reports head, eyes and 52 face shapes, nothing below the neck
 *   - three extra axis-flip config nodes, because the euler convention the
 *     device uses is not pinned down by the published spec
 */
export const IFACIALMOCAP_PIPELINE_TEMPLATE: Omit<GraphDescriptor, 'id'> = {
  label: 'iFacialMocap Receiver Pipeline',
  readonly: true,
  nodes: [
    // ── Behavior config value sources ─────────────────────────────────────────
    // Each exposes ONE field from the behavior config via its `value` output port.
    // Columns: x=-520 (cfg), x=-240 (source), x=60 (unpack), x=280 (mappers), x=560 (calib/sum), x=760+ (out)
    {
      id: 'cfg_device_host',
      kind: 'behavior_config',
      position: { x: -520, y: 80 },
      defaultConfig: { field: 'deviceHost', defaultValue: '' },
    },
    {
      id: 'cfg_port',
      kind: 'behavior_config',
      position: { x: -520, y: 200 },
      defaultConfig: { field: 'port', defaultValue: 49983 },
    },
    {
      id: 'cfg_mirror',
      kind: 'behavior_config',
      position: { x: -520, y: 320 },
      defaultConfig: { field: 'mirror', defaultValue: false },
    },
    {
      id: 'cfg_invert_pitch',
      kind: 'behavior_config',
      position: { x: -520, y: 0 },
      defaultConfig: { field: 'invertPitch', defaultValue: false },
    },
    {
      id: 'cfg_invert_yaw',
      kind: 'behavior_config',
      position: { x: -520, y: -80 },
      defaultConfig: { field: 'invertYaw', defaultValue: false },
    },
    {
      id: 'cfg_invert_roll',
      kind: 'behavior_config',
      position: { x: -520, y: -160 },
      defaultConfig: { field: 'invertRoll', defaultValue: false },
    },
    // Mapper config pairs — 160 px between en/map, 240 px between mapper groups.
    {
      id: 'cfg_fcl_en',
      kind: 'behavior_config',
      position: { x: -520, y: 540 },
      defaultConfig: {
        field: 'nodeConfig.arkit_fcl_cfg.enabled',
        defaultValue: true,
      },
    },
    {
      id: 'cfg_fcl_map',
      kind: 'behavior_config',
      position: { x: -520, y: 660 },
      defaultConfig: {
        field: 'nodeConfig.arkit_fcl_cfg.mapping',
        defaultValue: null,
      },
    },
    {
      id: 'cfg_expr_en',
      kind: 'behavior_config',
      position: { x: -520, y: 820 },
      defaultConfig: {
        field: 'nodeConfig.arkit_expr_cfg.enabled',
        defaultValue: false,
      },
    },
    {
      id: 'cfg_expr_map',
      kind: 'behavior_config',
      position: { x: -520, y: 940 },
      defaultConfig: {
        field: 'nodeConfig.arkit_expr_cfg.mapping',
        defaultValue: null,
      },
    },
    {
      id: 'cfg_pass_en',
      kind: 'behavior_config',
      position: { x: -520, y: 1100 },
      defaultConfig: {
        field: 'nodeConfig.arkit_pass_cfg.enabled',
        defaultValue: false,
      },
    },
    {
      id: 'cfg_pass_map',
      kind: 'behavior_config',
      position: { x: -520, y: 1220 },
      defaultConfig: {
        field: 'nodeConfig.arkit_pass_cfg.mapping',
        defaultValue: null,
      },
    },
    // ── Other internal context nodes ─────────────────────────────────────────
    { id: 'comp_id', kind: 'behavior_id', position: { x: -240, y: -220 } },
    { id: 'scene_entity', kind: 'scene_entity', position: { x: 920, y: -220 } },
    // ── Behavior trigger bridges (UI buttons → graph) ────────────────────────
    {
      id: 'head_calib_capture',
      kind: 'component_trigger',
      position: { x: 60, y: -220 },
      defaultConfig: { button: 'Capture head neutral' },
    },
    {
      id: 'head_calib_reset',
      kind: 'component_trigger',
      position: { x: 220, y: -220 },
      defaultConfig: { button: 'Reset head' },
    },
    // ── Processing ───────────────────────────────────────────────────────────
    {
      id: 'ifm',
      kind: 'ifacialmocap_packet_source',
      position: { x: -240, y: 80 },
    },
    // Unpack nodes split each event into a trigger (→ broadcast) and a value (← pulled by processors).
    { id: 'unpack_bones', kind: 'unpack_event', position: { x: 60, y: 80 } },
    { id: 'unpack_arkit', kind: 'unpack_event', position: { x: 60, y: 600 } },
    {
      id: 'bone_mapper',
      kind: 'rhylive_bone_mapper',
      position: { x: 280, y: 80 },
    },
    // Three ARKit mapper nodes — aligned with their cfg pairs above.
    {
      id: 'arkit_fcl',
      kind: 'arkit_vrm_mapper',
      position: { x: 280, y: 600 },
      defaultConfig: { mode: 'fcl' },
    },
    {
      id: 'arkit_expr',
      kind: 'arkit_vrm_mapper',
      position: { x: 280, y: 880 },
      defaultConfig: { mode: 'expressions' },
    },
    {
      id: 'arkit_pass',
      kind: 'arkit_vrm_mapper',
      position: { x: 280, y: 1160 },
      defaultConfig: { mode: 'passthrough' },
    },
    // ── Calibration: head/eyes ───────────────────────────────────────────────
    { id: 'head_calib', kind: 'body_calibration', position: { x: 560, y: 80 } },
    // ── Blendshapes merge (pure pull) ────────────────────────────────────────
    { id: 'bs_sum', kind: 'blendshapes_sum', position: { x: 560, y: 880 } },
    // ── Output ───────────────────────────────────────────────────────────────
    { id: 'pose_out', kind: 'pose_broadcast', position: { x: 1040, y: 80 } },
    {
      id: 'bs_out',
      kind: 'blendshapes_broadcast',
      position: { x: 760, y: 880 },
    },
  ],
  edges: [
    // ── Value: socket + axis config ───────────────────────────────────────────
    {
      fromNodeId: 'cfg_device_host',
      fromPort: 'value',
      toNodeId: 'ifm',
      toPort: 'deviceHost',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_port',
      fromPort: 'value',
      toNodeId: 'ifm',
      toPort: 'port',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_invert_pitch',
      fromPort: 'value',
      toNodeId: 'ifm',
      toPort: 'invertPitch',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_invert_yaw',
      fromPort: 'value',
      toNodeId: 'ifm',
      toPort: 'invertYaw',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_invert_roll',
      fromPort: 'value',
      toNodeId: 'ifm',
      toPort: 'invertRoll',
      kind: 'value',
    },
    // ── Event: source → unpack nodes ──────────────────────────────────────────
    {
      fromNodeId: 'ifm',
      fromPort: 'bones',
      toNodeId: 'unpack_bones',
      toPort: 'event',
    },
    {
      fromNodeId: 'ifm',
      fromPort: 'arkit',
      toNodeId: 'unpack_arkit',
      toPort: 'event',
    },
    // ── Event: unpack triggers → broadcast nodes ───────────────────────────────
    {
      fromNodeId: 'unpack_bones',
      fromPort: 'trigger',
      toNodeId: 'pose_out',
      toPort: 'trigger',
    },
    {
      fromNodeId: 'unpack_arkit',
      fromPort: 'trigger',
      toNodeId: 'bs_out',
      toPort: 'trigger',
    },
    // ── Value: bone chain — pose_out ← head_calib ← bone_mapper ← unpack_bones ──
    {
      fromNodeId: 'head_calib',
      fromPort: 'pose',
      toNodeId: 'pose_out',
      toPort: 'pose',
      kind: 'value',
    },
    {
      fromNodeId: 'bone_mapper',
      fromPort: 'pose',
      toNodeId: 'head_calib',
      toPort: 'pose',
      kind: 'value',
    },
    {
      fromNodeId: 'unpack_bones',
      fromPort: 'value',
      toNodeId: 'bone_mapper',
      toPort: 'bones',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_mirror',
      fromPort: 'value',
      toNodeId: 'bone_mapper',
      toPort: 'mirror',
      kind: 'value',
    },
    // ── Value: blendshape chain — bs_out ← bs_sum ← arkit_*/unpack_arkit ────
    {
      fromNodeId: 'bs_sum',
      fromPort: 'blendshapes',
      toNodeId: 'bs_out',
      toPort: 'blendshapes',
      kind: 'value',
    },
    {
      fromNodeId: 'arkit_fcl',
      fromPort: 'blendshapes',
      toNodeId: 'bs_sum',
      toPort: 'sources',
      kind: 'list',
    },
    {
      fromNodeId: 'arkit_expr',
      fromPort: 'blendshapes',
      toNodeId: 'bs_sum',
      toPort: 'sources',
      kind: 'list',
    },
    {
      fromNodeId: 'arkit_pass',
      fromPort: 'blendshapes',
      toNodeId: 'bs_sum',
      toPort: 'sources',
      kind: 'list',
    },
    {
      fromNodeId: 'unpack_arkit',
      fromPort: 'value',
      toNodeId: 'arkit_fcl',
      toPort: 'arkit',
      kind: 'value',
    },
    {
      fromNodeId: 'unpack_arkit',
      fromPort: 'value',
      toNodeId: 'arkit_expr',
      toPort: 'arkit',
      kind: 'value',
    },
    {
      fromNodeId: 'unpack_arkit',
      fromPort: 'value',
      toNodeId: 'arkit_pass',
      toPort: 'arkit',
      kind: 'value',
    },
    // ── Value: mapper config ───────────────────────────────────────────────────
    {
      fromNodeId: 'cfg_fcl_en',
      fromPort: 'value',
      toNodeId: 'arkit_fcl',
      toPort: 'enabled',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_fcl_map',
      fromPort: 'value',
      toNodeId: 'arkit_fcl',
      toPort: 'mapping',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_expr_en',
      fromPort: 'value',
      toNodeId: 'arkit_expr',
      toPort: 'enabled',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_expr_map',
      fromPort: 'value',
      toNodeId: 'arkit_expr',
      toPort: 'mapping',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_pass_en',
      fromPort: 'value',
      toNodeId: 'arkit_pass',
      toPort: 'enabled',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_pass_map',
      fromPort: 'value',
      toNodeId: 'arkit_pass',
      toPort: 'mapping',
      kind: 'value',
    },
    // ── Value: nodeId + behaviorId for broadcast ──────────────────────────────
    {
      fromNodeId: 'scene_entity',
      fromPort: 'nodeId',
      toNodeId: 'pose_out',
      toPort: 'nodeId',
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
      toNodeId: 'pose_out',
      toPort: 'behaviorId',
      kind: 'value',
    },
    {
      fromNodeId: 'comp_id',
      fromPort: 'id',
      toNodeId: 'bs_out',
      toPort: 'behaviorId',
      kind: 'value',
    },
    // ── Event: calibration commands ────────────────────────────────────────────
    {
      fromNodeId: 'head_calib_capture',
      fromPort: 'trigger',
      toNodeId: 'head_calib',
      toPort: 'capture',
    },
    {
      fromNodeId: 'head_calib_reset',
      fromPort: 'trigger',
      toNodeId: 'head_calib',
      toPort: 'reset',
    },
  ],
};

/** Graph id prefix — mirrors `vmc-pipeline:` so route dispatch can tell them apart. */
export const IFACIALMOCAP_GRAPH_PREFIX = 'ifacialmocap-pipeline:';

export function makeIFacialMocapGraphDescriptor(
  behaviorId: string
): GraphDescriptor {
  return {
    ...IFACIALMOCAP_PIPELINE_TEMPLATE,
    id: `${IFACIALMOCAP_GRAPH_PREFIX}${behaviorId}`,
  };
}
