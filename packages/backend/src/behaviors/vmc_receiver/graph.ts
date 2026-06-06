import type { GraphDescriptor } from '@vspark/shared/signal';

// VRM bone names scoped to the head/spine calibration stage.
export const HEAD_CALIB_BONES = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'jaw',
  'leftEye',
  'rightEye',
] as const;

export const VMC_PIPELINE_TEMPLATE: Omit<GraphDescriptor, 'id'> = {
  label: 'VMC Receiver Pipeline',
  readonly: true,
  nodes: [
    // ── Component config value sources ────────────────────────────────────────
    // Each exposes ONE field from the component config via its `value` output port.
    // Columns: x=-520 (cfg), x=-240 (vmc source), x=60 (mappers+bone), x=360 (calib/bs), x=640 (arm), x=920 (out)
    {
      id: 'cfg_host',
      kind: 'behavior_config',
      position: { x: -520, y: 80 },
      defaultConfig: { field: 'host', defaultValue: '0.0.0.0' },
    },
    {
      id: 'cfg_port',
      kind: 'behavior_config',
      position: { x: -520, y: 200 },
      defaultConfig: { field: 'port', defaultValue: 39539 },
    },
    {
      id: 'cfg_mirror',
      kind: 'behavior_config',
      position: { x: -520, y: 320 },
      defaultConfig: { field: 'mirror', defaultValue: false },
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
    // ── Component trigger bridges (UI buttons → graph) ───────────────────────
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
    {
      id: 'left_arm_capture',
      kind: 'component_trigger',
      position: { x: 380, y: -220 },
      defaultConfig: { button: 'Capture left arm' },
    },
    {
      id: 'right_arm_capture',
      kind: 'component_trigger',
      position: { x: 540, y: -220 },
      defaultConfig: { button: 'Capture right arm' },
    },
    {
      id: 'arm_calib_reset',
      kind: 'component_trigger',
      position: { x: 380, y: -360 },
      defaultConfig: { button: 'Reset arms' },
    },
    // ── Processing ───────────────────────────────────────────────────────────
    { id: 'vmc', kind: 'vmc_packet_source', position: { x: -240, y: 80 } },
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
    // ── Calibration: head/spine ──────────────────────────────────────────────
    { id: 'head_calib', kind: 'body_calibration', position: { x: 560, y: 80 } },
    // ── Calibration: arms ────────────────────────────────────────────────────
    {
      id: 'arm_ik_calib',
      kind: 'arm_ik_calibration',
      position: { x: 760, y: 80 },
    },
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
    // ── Value: socket config ──────────────────────────────────────────────────
    {
      fromNodeId: 'cfg_host',
      fromPort: 'value',
      toNodeId: 'vmc',
      toPort: 'host',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_port',
      fromPort: 'value',
      toNodeId: 'vmc',
      toPort: 'port',
      kind: 'value',
    },
    // ── Event: vmc source → unpack nodes ──────────────────────────────────────
    {
      fromNodeId: 'vmc',
      fromPort: 'bones',
      toNodeId: 'unpack_bones',
      toPort: 'event',
    },
    {
      fromNodeId: 'vmc',
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
    // ── Value: bone chain — pose_out ← arm_ik_calib ← head_calib ← bone_mapper ← unpack_bones ──
    {
      fromNodeId: 'arm_ik_calib',
      fromPort: 'pose',
      toNodeId: 'pose_out',
      toPort: 'pose',
      kind: 'value',
    },
    {
      fromNodeId: 'head_calib',
      fromPort: 'pose',
      toNodeId: 'arm_ik_calib',
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
    {
      fromNodeId: 'left_arm_capture',
      fromPort: 'trigger',
      toNodeId: 'arm_ik_calib',
      toPort: 'capture_left',
    },
    {
      fromNodeId: 'right_arm_capture',
      fromPort: 'trigger',
      toNodeId: 'arm_ik_calib',
      toPort: 'capture_right',
    },
    {
      fromNodeId: 'arm_calib_reset',
      fromPort: 'trigger',
      toNodeId: 'arm_ik_calib',
      toPort: 'reset',
    },
  ],
};

export function makeVmcGraphDescriptor(behaviorId: string): GraphDescriptor {
  return { ...VMC_PIPELINE_TEMPLATE, id: `vmc-pipeline:${behaviorId}` };
}

// ── 2D puppet variant ───────────────────────────────────────────────────────
// Live2D puppets only consume head/neck rotation + blendshapes. They have no
// VRM skeleton, so the skeleton-dependent arm-IK stage is meaningless. This
// template is the full pipeline minus the arm-IK node and its three arm
// calibration triggers, with the head/spine calibration wired straight to the
// pose broadcast. Everything else — the VMC source, OSC ingest, RhyLive bone
// mapping, ARKit blendshape mappers, head-neutral calibration — is shared
// verbatim, so it can't drift from the 3D pipeline.
const ARM_NODE_IDS = new Set([
  'arm_ik_calib',
  'left_arm_capture',
  'right_arm_capture',
  'arm_calib_reset',
]);

export const VMC_2D_PIPELINE_TEMPLATE: Omit<GraphDescriptor, 'id'> = {
  ...VMC_PIPELINE_TEMPLATE,
  label: 'VMC Receiver Pipeline (2D)',
  nodes: VMC_PIPELINE_TEMPLATE.nodes.filter((n) => !ARM_NODE_IDS.has(n.id)),
  edges: [
    // Drop every edge touching an arm node (this removes arm_ik_calib → pose_out
    // and head_calib → arm_ik_calib)…
    ...VMC_PIPELINE_TEMPLATE.edges.filter(
      (e) => !ARM_NODE_IDS.has(e.fromNodeId) && !ARM_NODE_IDS.has(e.toNodeId)
    ),
    // …then reconnect the bone chain end directly to the broadcast.
    {
      fromNodeId: 'head_calib',
      fromPort: 'pose',
      toNodeId: 'pose_out',
      toPort: 'pose',
      kind: 'value',
    },
  ],
};

export function makeVmcGraphDescriptor2d(behaviorId: string): GraphDescriptor {
  return { ...VMC_2D_PIPELINE_TEMPLATE, id: `vmc-pipeline-2d:${behaviorId}` };
}
