import type { GraphDescriptor } from '@vspark/shared/signal'

export const MEDIAPIPE_PIPELINE_TEMPLATE: Omit<GraphDescriptor, 'id'> = {
  label:    'MediaPipe Tracker',
  readonly: true,
  nodes: [
    // ── Infrastructure ───────────────────────────────────────────────────────
    { id: 'comp_id',      kind: 'component_id',    position: { x: -300, y: -80 } },
    { id: 'scene_entity', kind: 'scene_entity',    position: { x:  960, y: -80 } },
    // ── Config toggles ────────────────────────────────────────────────────────
    { id: 'cfg_enable_face',  kind: 'component_config', position: { x: -300, y:  80 },
      defaultConfig: { field: 'enableFace',  defaultValue: true } },
    { id: 'cfg_enable_pose',  kind: 'component_config', position: { x: -300, y: 160 },
      defaultConfig: { field: 'enablePose',  defaultValue: true } },
    { id: 'cfg_enable_hands', kind: 'component_config', position: { x: -300, y: 240 },
      defaultConfig: { field: 'enableHands', defaultValue: true } },
    // ── Entry point (fired by TrackingManager) ───────────────────────────────
    { id: 'mp_source',    kind: 'mediapipe_source',  position: { x: -60,  y:   0 } },
    // ── Face pipeline ─────────────────────────────────────────────────────────
    { id: 'face_to_bs',   kind: 'face_landmarks_to_blendshapes', position: { x: 260, y: -80 } },
    { id: 'bs_out',       kind: 'blendshapes_broadcast',          position: { x: 620, y: -80 } },
    // ── Pose pipeline ─────────────────────────────────────────────────────────
    { id: 'pose_to_bones', kind: 'pose_landmarks_to_bones', position: { x: 260, y: 80  } },
    { id: 'pose_out',      kind: 'pose_broadcast',           position: { x: 960, y: 80  } },
    // ── Left hand pipeline ───────────────────────────────────────────────────
    { id: 'left_hand',    kind: 'hand_landmarks_to_bones', position: { x: 260, y: 200 },
      defaultConfig: { side: 'left' } },
    { id: 'left_apply',   kind: 'pose_apply_bone',         position: { x: 620, y: 200 } },
    // ── Right hand pipeline ──────────────────────────────────────────────────
    { id: 'right_hand',   kind: 'hand_landmarks_to_bones', position: { x: 260, y: 320 },
      defaultConfig: { side: 'right' } },
    { id: 'right_apply',  kind: 'pose_apply_bone',         position: { x: 620, y: 320 } },
  ],
  edges: [
    // ── Face → blendshapes ───────────────────────────────────────────────────
    { fromNodeId: 'mp_source',    fromPort: 'face',        toNodeId: 'face_to_bs',    toPort: 'face'        },
    { fromNodeId: 'face_to_bs',   fromPort: 'out',         toNodeId: 'bs_out',        toPort: 'trigger'     },
    { fromNodeId: 'face_to_bs',   fromPort: 'blendshapes', toNodeId: 'bs_out',        toPort: 'blendshapes', kind: 'value' },
    { fromNodeId: 'scene_entity', fromPort: 'nodeId',      toNodeId: 'bs_out',        toPort: 'nodeId',      kind: 'value' },
    // ── Pose → bones ─────────────────────────────────────────────────────────
    { fromNodeId: 'mp_source',    fromPort: 'pose',        toNodeId: 'pose_to_bones', toPort: 'pose'        },
    { fromNodeId: 'pose_to_bones',fromPort: 'out',         toNodeId: 'pose_out',      toPort: 'trigger'     },
    { fromNodeId: 'right_apply',  fromPort: 'pose',        toNodeId: 'pose_out',      toPort: 'pose',        kind: 'value' },
    { fromNodeId: 'scene_entity', fromPort: 'nodeId',      toNodeId: 'pose_out',      toPort: 'nodeId',      kind: 'value' },
    // ── Left hand → finger bones → merge into pose chain ────────────────────
    { fromNodeId: 'mp_source',    fromPort: 'leftHand',    toNodeId: 'left_hand',     toPort: 'landmarks'   },
    { fromNodeId: 'left_hand',    fromPort: 'pose',        toNodeId: 'left_apply',    toPort: 'pose',        kind: 'value' },
    { fromNodeId: 'pose_to_bones',fromPort: 'pose',        toNodeId: 'left_apply',    toPort: 'pose',        kind: 'value' },
    // ── Right hand → finger bones ────────────────────────────────────────────
    { fromNodeId: 'mp_source',    fromPort: 'rightHand',   toNodeId: 'right_hand',    toPort: 'landmarks'   },
    { fromNodeId: 'right_hand',   fromPort: 'pose',        toNodeId: 'right_apply',   toPort: 'pose',        kind: 'value' },
    { fromNodeId: 'left_apply',   fromPort: 'pose',        toNodeId: 'right_apply',   toPort: 'pose',        kind: 'value' },
  ],
}

export function makeMediapipeGraphDescriptor(componentId: string): GraphDescriptor {
  return { ...MEDIAPIPE_PIPELINE_TEMPLATE, id: `mediapipe_tracker:${componentId}` }
}
