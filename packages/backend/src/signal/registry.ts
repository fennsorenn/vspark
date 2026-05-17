import type { SignalNodeClass, NodeKindMeta } from '@vspark/shared/signal'
import { getNodeDisplay } from '@vspark/shared/signal'
import { ComponentId }        from './nodes/component_id.js'
import { ComponentConfigNode } from './nodes/component_config.js'
import { SceneEntity }        from './nodes/scene_entity.js'
import { ManualTrigger }      from './nodes/manual_trigger.js'
import { ArmIkCalibration }  from './nodes/arm_ik_calibration.js'
import { VmcPacketSource }    from './nodes/vmc_packet_source.js'
import { RhyliveBoneMapper }  from './nodes/rhylive_bone_mapper.js'
import { ArkitVrmMapper }     from './nodes/arkit_vrm_mapper.js'
import { BodyCalibration }    from './nodes/body_calibration.js'
import { PoseBroadcast }             from './nodes/pose_broadcast.js'
import { BlendshapesBroadcast }      from './nodes/blendshapes_broadcast.js'
import { BlendshapesSum }            from './nodes/blendshapes_sum.js'
import { UnpackEvent }               from './nodes/unpack_event.js'
import { OnPoseBroadcast }           from './nodes/on_pose_broadcast.js'
import { PoseInterceptorBroadcast }  from './nodes/pose_interceptor_broadcast.js'
import { Clock }                     from './nodes/clock.js'
import { Time }                      from './nodes/time.js'
import { SineWave }                  from './nodes/sine_wave.js'
import { EulerToQuaternion }         from './nodes/euler_to_quaternion.js'
import { PoseApplyBone }             from './nodes/pose_apply_bone.js'
// Lipsync nodes
import { LipsyncSource }             from './nodes/lipsync_source.js'
import { VisemePassthrough }         from './nodes/viseme_passthrough.js'
// MediaPipe tracking nodes
import { MediapipeSource }              from './nodes/mediapipe_source.js'
import { FaceLandmarksToBlendshapes }   from './nodes/face_landmarks_to_blendshapes.js'
import { PoseLandmarksToBones }         from './nodes/pose_landmarks_to_bones.js'
import { HandLandmarksToBones }         from './nodes/hand_landmarks_to_bones.js'

// ──────────────────────────────────────────────────────────────────────────────
// All known node kinds. Import a new class here to auto-register it.
// ──────────────────────────────────────────────────────────────────────────────

const ALL_NODE_CLASSES: SignalNodeClass[] = [
  // Context / value nodes (internal — hidden from user palette)
  ComponentId,
  ComponentConfigNode,
  SceneEntity,
  ManualTrigger,
  ArmIkCalibration,
  // Processing nodes
  VmcPacketSource,
  RhyliveBoneMapper,
  ArkitVrmMapper,
  BodyCalibration,
  // Output nodes
  PoseBroadcast,
  BlendshapesBroadcast,
  BlendshapesSum,
  UnpackEvent,
// Interceptor nodes
  OnPoseBroadcast,
  PoseInterceptorBroadcast,
  // Math / procedural nodes
  Clock,
  Time,
  SineWave,
  EulerToQuaternion,
  PoseApplyBone,
  // Lipsync nodes
  LipsyncSource,
  VisemePassthrough,
  // MediaPipe tracking nodes
  MediapipeSource,
  FaceLandmarksToBlendshapes,
  PoseLandmarksToBones,
  HandLandmarksToBones,
]

export const NODE_REGISTRY: ReadonlyMap<string, SignalNodeClass> =
  new Map(ALL_NODE_CLASSES.map((cls) => [cls.kind, cls]))

export function getAllNodeKindMeta(): NodeKindMeta[] {
  return ALL_NODE_CLASSES.map((cls) => ({
    kind:        cls.kind,
    inputPorts:  cls.inputPorts.map((p) => ({ name: p.name, type: p.type, portKind: p.kind })),
    outputPorts: cls.outputPorts.map((p) => ({ name: p.name, type: p.type, portKind: p.kind })),
    display:     getNodeDisplay(cls),
  }))
}
