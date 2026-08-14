import type {
  SignalNodeClass,
  NodeKindMeta,
  NodePortMeta,
} from '@vspark/shared/signal';
import { getNodeDisplay } from '@vspark/shared/signal';
import { getPortMeta, type PortMeta } from '@vspark/shared/node';
import { typeTagToResolved } from '@vspark/shared/signal_types';
import { INFER_BY_KIND } from '@vspark/shared/infer_nodes';
import { BehaviorId } from './nodes/behavior_id.js';
import { BehaviorConfigNode } from './nodes/behavior_config.js';
import { SceneEntity } from './nodes/scene_entity.js';
import { ManualTrigger } from './nodes/manual_trigger.js';
import { ArmIkCalibration } from './nodes/arm_ik_calibration.js';
import { VmcPacketSource } from './nodes/vmc_packet_source.js';
import { IFacialMocapPacketSource } from './nodes/ifacialmocap_packet_source.js';
import { RhyliveBoneMapper } from './nodes/rhylive_bone_mapper.js';
import { ArkitVrmMapper } from './nodes/arkit_vrm_mapper.js';
import { BodyCalibration } from './nodes/body_calibration.js';
import { PoseManualCalibration } from './nodes/pose_manual_calibration.js';
import { PoseStyleDrivers } from './nodes/pose_style_drivers.js';
import { PoseStylize } from './nodes/pose_stylize.js';
import { PoseBroadcast } from './nodes/pose_broadcast.js';
import { BlendshapesBroadcast } from './nodes/blendshapes_broadcast.js';
import { BlendshapesSum } from './nodes/blendshapes_sum.js';
import { UnpackEvent } from './nodes/unpack_event.js';
import { PackEvent } from './nodes/pack_event.js';
import { QueueEvents } from './nodes/queue_events.js';
import { OnPoseBroadcast } from './nodes/on_pose_broadcast.js';
import { PoseInterceptorBroadcast } from './nodes/pose_interceptor_broadcast.js';
import { OnBlendshapesBroadcast } from './nodes/on_blendshapes_broadcast.js';
import { BlendshapesInterceptorBroadcast } from './nodes/blendshapes_interceptor_broadcast.js';
import { BlendshapeLimits } from './nodes/blendshape_limits.js';
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
import { SpawnClip } from './nodes/spawn_clip.js';
import { Random } from './nodes/random.js';
import { SetSceneNodeParam } from './nodes/set_scene_node_param.js';
import { SetComposeLayerParam } from './nodes/set_compose_layer_param.js';
import { SetText } from './nodes/set_text.js';
import { SetData } from './nodes/set_data.js';
import { MediaControl } from './nodes/media_control.js';
import { LogNode } from './nodes/log.js';
// Overlive event nodes
import { OverliveRedemption } from './nodes/overlive/redemption.js';
import { OverliveSubscription } from './nodes/overlive/subscription.js';
import { OverliveGiftBomb } from './nodes/overlive/gift_bomb.js';
import { OverliveRaid } from './nodes/overlive/raid.js';
import { OverliveFollow } from './nodes/overlive/follow.js';
import { OverliveChatMessage } from './nodes/overlive/chat_message.js';
import { OverliveChatFeed } from './nodes/overlive/chat_feed.js';
import { OverliveChatCommand } from './nodes/overlive/chat_command.js';
import { OverliveChatDelete } from './nodes/overlive/chat_delete.js';
import { OverliveAdStart } from './nodes/overlive/ad_start.js';
import { OverliveAdEnd } from './nodes/overlive/ad_end.js';
import { OverliveBan } from './nodes/overlive/ban.js';
import { OverliveStreamOnline } from './nodes/overlive/stream_online.js';
import { OverliveStreamOffline } from './nodes/overlive/stream_offline.js';
import { OverliveSendChat } from './nodes/overlive/send_chat.js';
// Overlive outbound action nodes
import { OverliveAnnounce, OverliveShoutout, OverliveChatColor } from './nodes/overlive/actions_chat.js';
import {
  OverliveUpdateChannel,
  OverliveStreamMarker,
  OverliveCommercial,
  OverliveSnoozeAd,
} from './nodes/overlive/actions_channel.js';
import { OverliveRedemptionStatus } from './nodes/overlive/actions_points.js';
import {
  OverliveBanUser,
  OverliveUnban,
  OverliveDeleteMessage,
  OverliveChatSettings,
  OverliveWarn,
  OverliveAutoMod,
} from './nodes/overlive/actions_moderation.js';
import {
  OverliveAddVip,
  OverliveRemoveVip,
  OverliveAddModerator,
  OverliveRemoveModerator,
} from './nodes/overlive/actions_roles.js';
import {
  OverlivePollCreate,
  OverlivePollEnd,
  OverlivePredictionCreate,
  OverlivePredictionEnd,
  OverliveRaidStart,
  OverliveRaidCancel,
} from './nodes/overlive/actions_interactive.js';
import { OverliveWhisper } from './nodes/overlive/actions_dm.js';
// OBS browser-source bridge nodes
import { ObsSceneChanged } from './nodes/obs/scene_changed.js';
import { ObsOutputState } from './nodes/obs/output_state.js';
import { ObsSetScene } from './nodes/obs/set_scene.js';
import { ObsSetTransition } from './nodes/obs/set_transition.js';
import { ObsControl } from './nodes/obs/control.js';
// OBS power tier (obs-websocket) nodes
import { ObsSetVolume } from './nodes/obs/set_volume.js';
import { ObsMute } from './nodes/obs/mute.js';
import { ObsVolumeChanged } from './nodes/obs/volume_changed.js';
import { ObsMuteChanged } from './nodes/obs/mute_changed.js';
import { ObsReplayPath } from './nodes/obs/replay_path.js';
import { ObsConnectionState } from './nodes/obs/connection_state.js';
// Render-client lifecycle (vspark-native, driven by the browser-source bridge)
import { ClientLifecycle } from './nodes/client_lifecycle.js';

// ──────────────────────────────────────────────────────────────────────────────
// All known node kinds. Import a new class here to auto-register it.
// ──────────────────────────────────────────────────────────────────────────────

const ALL_NODE_CLASSES: SignalNodeClass[] = [
  // Context / value nodes (internal — hidden from user palette)
  BehaviorId,
  BehaviorConfigNode,
  SceneEntity,
  ManualTrigger,
  ArmIkCalibration,
  // Processing nodes
  VmcPacketSource,
  IFacialMocapPacketSource,
  RhyliveBoneMapper,
  ArkitVrmMapper,
  BodyCalibration,
  PoseManualCalibration,
  PoseStyleDrivers,
  PoseStylize,
  // Output nodes
  PoseBroadcast,
  BlendshapesBroadcast,
  BlendshapesSum,
  UnpackEvent,
  PackEvent,
  QueueEvents,
  // Interceptor nodes
  OnPoseBroadcast,
  PoseInterceptorBroadcast,
  OnBlendshapesBroadcast,
  BlendshapesInterceptorBroadcast,
  BlendshapeLimits,
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
  SpawnClip,
  // Runtime mutation / spawn primitives (Phase 1.5)
  Random,
  SetSceneNodeParam,
  SetComposeLayerParam,
  SetText,
  SetData,
  // Media playback control (fire-and-forget command bus)
  MediaControl,
  // Debug
  LogNode,
  // Overlive event nodes
  OverliveRedemption,
  OverliveSubscription,
  OverliveGiftBomb,
  OverliveRaid,
  OverliveFollow,
  OverliveChatMessage,
  OverliveChatFeed,
  OverliveChatCommand,
  OverliveChatDelete,
  OverliveAdStart,
  OverliveAdEnd,
  OverliveBan,
  OverliveStreamOnline,
  OverliveStreamOffline,
  OverliveSendChat,
  // Overlive outbound action nodes
  OverliveAnnounce,
  OverliveShoutout,
  OverliveChatColor,
  OverliveUpdateChannel,
  OverliveStreamMarker,
  OverliveCommercial,
  OverliveSnoozeAd,
  OverliveRedemptionStatus,
  OverliveBanUser,
  OverliveUnban,
  OverliveDeleteMessage,
  OverliveChatSettings,
  OverliveWarn,
  OverliveAutoMod,
  OverliveAddVip,
  OverliveRemoveVip,
  OverliveAddModerator,
  OverliveRemoveModerator,
  OverlivePollCreate,
  OverlivePollEnd,
  OverlivePredictionCreate,
  OverlivePredictionEnd,
  OverliveRaidStart,
  OverliveRaidCancel,
  OverliveWhisper,
  // OBS browser-source bridge — event sources + control actions
  ObsSceneChanged,
  ObsOutputState,
  ObsSetScene,
  ObsSetTransition,
  ObsControl,
  // OBS power tier (obs-websocket) — audio + connection
  ObsSetVolume,
  ObsMute,
  ObsVolumeChanged,
  ObsMuteChanged,
  ObsReplayPath,
  ObsConnectionState,
  // Render-client lifecycle
  ClientLifecycle,
];

export const NODE_REGISTRY: ReadonlyMap<string, SignalNodeClass> = new Map(
  ALL_NODE_CLASSES.map((cls) => [cls.kind, cls])
);

function toPortMeta(p: PortMeta): NodePortMeta {
  return {
    name: p.name,
    resolved: typeTagToResolved(p.typeTag, p.transport),
    typeTag: p.typeTag,
    transport: p.transport,
  };
}

export function getAllNodeKindMeta(): NodeKindMeta[] {
  return ALL_NODE_CLASSES.map((cls) => {
    const ports = getPortMeta(cls);
    return {
      kind: cls.kind,
      inputPorts: ports.filter((p) => p.direction === 'in').map(toPortMeta),
      outputPorts: ports.filter((p) => p.direction === 'out').map(toPortMeta),
      display: getNodeDisplay(cls),
      dynamic: cls.kind in INFER_BY_KIND,
    };
  });
}
