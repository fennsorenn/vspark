import type { SignalNodeClass, NodeKindMeta } from '@vspark/shared/signal';
import { getNodeDisplay } from '@vspark/shared/signal';
import { ComponentId } from './nodes/component_id.js';
import { ComponentConfigNode } from './nodes/component_config.js';
import { SceneEntity } from './nodes/scene_entity.js';
import { ManualTrigger } from './nodes/manual_trigger.js';
import { ArmIkCalibration } from './nodes/arm_ik_calibration.js';
import { VmcPacketSource } from './nodes/vmc_packet_source.js';
import { RhyliveBoneMapper } from './nodes/rhylive_bone_mapper.js';
import { ArkitVrmMapper } from './nodes/arkit_vrm_mapper.js';
import { BodyCalibration } from './nodes/body_calibration.js';
import { PoseBroadcast } from './nodes/pose_broadcast.js';
import { BlendshapesBroadcast } from './nodes/blendshapes_broadcast.js';
import { BlendshapesSum } from './nodes/blendshapes_sum.js';
import { UnpackEvent } from './nodes/unpack_event.js';
import { OnPoseBroadcast } from './nodes/on_pose_broadcast.js';
import { PoseInterceptorBroadcast } from './nodes/pose_interceptor_broadcast.js';
import { Clock } from './nodes/clock.js';
import { Time } from './nodes/time.js';
import { SineWave } from './nodes/sine_wave.js';
import { EulerToQuaternion } from './nodes/euler_to_quaternion.js';
import { Multiply } from './nodes/multiply.js';
import { PoseApplyBone } from './nodes/pose_apply_bone.js';
import { PoseMerge } from './nodes/pose_merge.js';
// Lipsync nodes
import { LipsyncSource } from './nodes/lipsync_source.js';
import { VisemePassthrough } from './nodes/viseme_passthrough.js';
// MediaPipe tracking nodes
import { MediapipeSource } from './nodes/mediapipe_source.js';
import { FaceLandmarksToBlendshapes } from './nodes/face_landmarks_to_blendshapes.js';
import { PoseTorsoHeadToBones } from './nodes/pose_torso_head_to_bones.js';
import { PoseArmsToBones } from './nodes/pose_arms_to_bones.js';
import { HandLandmarksToBones } from './nodes/hand_landmarks_to_bones.js';
import { PoseIkTargets } from './nodes/pose_ik_targets.js';
import { IkBroadcast } from './nodes/ik_broadcast.js';
import { NotBool } from './nodes/not_bool.js';
import { HandHeightCompare } from './nodes/hand_height_compare.js';
import { TrackClipTrigger } from './nodes/track_clip_trigger.js';
import { StartClip } from './nodes/start_clip.js';
import { Random } from './nodes/random.js';
import { SetSceneNodeParam } from './nodes/set_scene_node_param.js';
import { SetComposeLayerParam } from './nodes/set_compose_layer_param.js';
import { SetText } from './nodes/set_text.js';
import { LogNode } from './nodes/log.js';
// Overlive event nodes
import { OverliveRedemption } from './nodes/overlive/redemption.js';
import { OverliveSubscription } from './nodes/overlive/subscription.js';
import { OverliveGiftBomb } from './nodes/overlive/gift_bomb.js';
import { OverliveRaid } from './nodes/overlive/raid.js';
import { OverliveFollow } from './nodes/overlive/follow.js';
import { OverliveChatMessage } from './nodes/overlive/chat_message.js';
import { OverliveChatCommand } from './nodes/overlive/chat_command.js';
import { OverliveChatDelete } from './nodes/overlive/chat_delete.js';
import { OverliveAdStart } from './nodes/overlive/ad_start.js';
import { OverliveAdEnd } from './nodes/overlive/ad_end.js';
import { OverliveBan } from './nodes/overlive/ban.js';
import { OverliveStreamOnline } from './nodes/overlive/stream_online.js';
import { OverliveStreamOffline } from './nodes/overlive/stream_offline.js';

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
  Multiply,
  PoseApplyBone,
  PoseMerge,
  // Lipsync nodes
  LipsyncSource,
  VisemePassthrough,
  // MediaPipe tracking nodes
  MediapipeSource,
  FaceLandmarksToBlendshapes,
  PoseTorsoHeadToBones,
  PoseArmsToBones,
  HandLandmarksToBones,
  PoseIkTargets,
  IkBroadcast,
  // Logic utilities
  NotBool,
  HandHeightCompare,
  // Track clips
  TrackClipTrigger,
  StartClip,
  // Runtime mutation / spawn primitives (Phase 1.5)
  Random,
  SetSceneNodeParam,
  SetComposeLayerParam,
  SetText,
  // Debug
  LogNode,
  // Overlive event nodes
  OverliveRedemption,
  OverliveSubscription,
  OverliveGiftBomb,
  OverliveRaid,
  OverliveFollow,
  OverliveChatMessage,
  OverliveChatCommand,
  OverliveChatDelete,
  OverliveAdStart,
  OverliveAdEnd,
  OverliveBan,
  OverliveStreamOnline,
  OverliveStreamOffline,
];

export const NODE_REGISTRY: ReadonlyMap<string, SignalNodeClass> = new Map(
  ALL_NODE_CLASSES.map((cls) => [cls.kind, cls])
);

export function getAllNodeKindMeta(): NodeKindMeta[] {
  return ALL_NODE_CLASSES.map((cls) => ({
    kind: cls.kind,
    inputPorts: cls.inputPorts.map((p) => ({
      name: p.name,
      type: p.type,
      portKind: p.kind,
    })),
    outputPorts: cls.outputPorts.map((p) => ({
      name: p.name,
      type: p.type,
      portKind: p.kind,
    })),
    display: getNodeDisplay(cls),
  }));
}
