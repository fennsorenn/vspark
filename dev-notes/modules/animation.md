# Animation

Covers FBX/BVH retargeting to VRM, VMC live pose application, blendshape mapping, animation clip playback, and the signal graph nodes that sit in the pipeline.

## Overview

Two animation sources can drive a VRM avatar simultaneously, blended per-bone:

1. **Clip animation** — FBX or BVH file retargeted to VRM, played via Three.js `AnimationMixer`
2. **Live mocap** — VMC (RhyLive) or MediaPipe pose, processed server-side through the signal graph and broadcast as `NormalizedPose` over WebSocket

Both produce per-bone world-space quaternions. The blend weight ramps smoothly between them.

## Core types — `packages/shared/src/signal.ts`

**Convention: quaternions are always xyzw.** Every serialization path (JSON tuples, WS messages, DB state) uses `[x, y, z, w]`. Mixing this up with wxyz breaks all rotations silently.

**`Quaternion`**: Immutable unit quaternion. Methods: `multiply`, `invert`, `normalize`. Invalid (near-zero) quaternions normalize to `IDENTITY`.

**`BoneRotations`**: `Map<string, Quaternion>` — raw mocap data keyed by source app bone names (Unity HumanBodyBones, RhyLive format, etc.). Pre-mapping.

**`NormalizedPose`**: `Map<VRMBoneName, Quaternion>` — after mapping and coordinate correction. All downstream consumers use this.

**`VRM_BONE_NAMES`**: 54-element string array. The canonical key set for `NormalizedPose`. Covers full humanoid skeleton from hips through all finger distal bones.

## FBX/BVH retargeting — `Viewport.tsx`

Retargeting runs once when a clip is loaded (not per-frame). It bakes the remapped animation into VRM-compatible `QuaternionKeyframeTrack` objects. Playback is then handled by a standard Three.js `AnimationMixer`.

### Supported rig formats

**Mixamo**: bone names like `mixamorigHips`, `mixamorigSpine`, `mixamorigLeftArm`  
**UE4 Mannequin**: bone names like `pelvis`, `spine_01`, `upperarm_l`, `clavicle_r`, `thigh_l`, `ball_l`, finger names like `thumb_01_l`

Bone name → VRM name mapping tables (`MIXAMO_TO_VRM`, `UE4_TO_VRM`) are defined in Viewport.tsx.

### Retargeting algorithm (5 phases)

**Phase 1 — FBX bind world quaternions**

- If skinned FBX (has `SkinnedMesh`): extract bind world Qs from `boneInverses` (inverse bind matrices). This is exact.
- If animation-only FBX: chain local Qs root → leaf. Three.js places bones at rest on load, so local Qs represent the bind pose.

**Coordinate system detection (applied to all fbxBindWQ):**  
Infer Z-up vs Y-up by examining the spine direction (hips → chest). Compute `fbxCoordFix = rotation from detected up-axis to Y`. Apply to all fbxBindWQ. UE4 rigs typically need a 90°X correction; Mixamo gets identity (already Y-up).

**Phase 2 — VRM bind world quaternions**

Chain `bone.quaternion` root → leaf through the VRM skeleton to get world-space T-pose rotations per bone. Bones are sorted depth-first (parent before child) so parent WQ is always available when processing a child.

**Phase 3 — A-pose correction**

VRM uses T-pose (arms parallel to shoulder line). Most FBX animations use A-pose (arms at sides, possibly bent). The algorithm computes per-bone `vrmAposeWQ` — the world rotation the VRM bone would have if it were in the FBX rig's A-pose:

- **Hips**: full 3-axis basis alignment using spine direction, left thigh direction, right thigh direction
- **Other bones**: single-axis swing to align child bone directions between FBX and VRM skeletons
- **Hands**: basis correction including chirality — palm normal (cross product of finger directions) is canonicalized (`if fU.y > 0: fU.negate()`) to ensure anatomically correct orientation regardless of whether the source is left or right handed

**Phase 4 — Per-frame retargeting**

Uses frame 0 of the FBX animation as the reference pose (not the bind pose). Many FBX files — especially UE4 retargets — have frame 0 ≠ bind pose, so using the bind pose as reference produces drift. Frame 0 is treated as "equivalent to VRM T-pose" and all subsequent frames are deltas from it.

Per bone per frame:
```
fbxWorldQ = parentFBXWorldQ × trackQ_at_frame
worldDelta = fbxWorldQ × fbxRefWQ⁻¹         (frame 0 reference, not bind)
targetWQ   = worldDelta × vrmAposeWQ
vrmLocalQ  = vrmParentWorldQ⁻¹ × targetWQ
```

Result stored as `Float32Array` (xyzw × nFrames) per VRM bone.

**Phase 5 — Track creation**

Creates `THREE.QuaternionKeyframeTrack` per bone, attached to the VRM's skeleton nodes. Hips position track is also created: delta from FBX rest position, mapped through coordinate fix, scaled by 0.01 (FBX centimetre → metre).

**Loop clamping**: If the first and last keyframes match in quaternion distance (< 1e-3), the clip duration is trimmed to the second-to-last keyframe. This eliminates the single-frame hold at the loop boundary.

### Why world-space delta, not local-space

Local-space retargeting (copying bone local rotations directly) fails when the source and target rigs have different rest poses per bone. The world-space delta approach is invariant to rest pose differences — it encodes only the motion relative to rest, then re-expresses that motion in the target rig's coordinate frame. See memory `feedback_fbx_retargeting.md`.

## VMC live pose — signal graph pipeline

### Signal nodes (all in `packages/backend/src/signal/nodes/`)

**`rhylive_bone_mapper`**

Input: `BoneRotations` (VMC/RhyLive bone names)  
Output: `NormalizedPose` (VRM bone names)

Applies two transforms:
1. Name mapping via `VMC_TO_VRM` table
2. Coordinate flip: `q_out = (q.x, -q.y, -q.z, q.w)` — negates the Y and Z components of the quaternion vector part. RhyLive outputs in a different chirality/handedness than Three.js/VRM. This must happen before VRM application, not after.

Optional mirror mode: swaps left/right bones via `MIRROR_VMC` table.

**`body_calibration`**

Input: `NormalizedPose`  
Triggers: `capture`, `reset`  
State: `bodyOffsets` — per-bone quaternion captured at neutral position

Correction: `q_out = offset⁻¹ × q_in`

This subtracts the actor's neutral standing pose so that "rest" in the mocap space maps to T-pose on the VRM. Optional `boneFilter` whitelist for per-region calibration (e.g., calibrate only upper body).

**`arm_ik_calibration`**

Input: `NormalizedPose` + VRM skeleton data  
Triggers: `capture_left`, `capture_right`, `reset`  
State: `ArmCalib { scale: number, offset: [x,y,z] }` per side

Calibration: Actor touches index finger to eye corner. The system solves for a linear scale+offset that maps the actor's arm reach to the VRM's arm length.

Runtime: Corrected wrist position = shoulder + (wristRelative × scale) + offset. Then two-bone IK recomputes upper/lower arm local rotations to reach the corrected wrist.

Arm axis convention: Left arm +X, right arm -X (VRM T-pose convention).

**`pose_landmarks_to_bones`** (MediaPipe BlazePose)

Input: 33 world landmarks  
Output: `NormalizedPose` (spine, chest, upper/lower arms — 6 bones)

Per limb: rotate reference direction `[0,0,-1]` onto observed direction using `setFromUnitVectors`. Combines parent swing with local swing hierarchically.

**`hand_landmarks_to_bones`** (MediaPipe Hand)

Input: 21 hand landmarks  
Output: `NormalizedPose` (15 finger joints)

Per segment: quaternion from direction between consecutive landmarks. Left or right hand is configurable.

**`pose_apply_bone`**

Overrides a single named bone in a `NormalizedPose`. Modes: `multiply` (compose as delta) or `set` (replace). Used by the breathing component to inject sine-driven rotations into the pose chain.

**`euler_to_quaternion`**

Convention: ZYX intrinsic (Rz(roll) × Ry(yaw) × Rx(pitch)). Used by the breathing component to drive sine wave output into bone rotations.

### Pose interceptor chain

The `pose_broadcast` node doesn't fire directly to WebSocket. It first passes the pose through a chain of registered interceptors (e.g., the breathing component). Each interceptor receives the pose via `on_pose_broadcast`, modifies it, and re-emits it via `pose_interceptor_broadcast`. The chain is ordered by registration; the final output is what gets sent over WebSocket.

## Blendshape mapping — `arkit_vrm_mapper`

**Input**: ARKit 52-shape weights (from RhyLive `/Face` messages or MediaPipe face landmarks)  
**Output**: `Blendshapes` (VRM expression names or VRoid morph target names)

Three modes:
- `expressions` — maps to VRM standard expression names (happy, sad, angry, surprised, relaxed)
- `fcl` — maps to VRoid `Fcl_*` morph target names (Fcl_EYE_Close_L, Fcl_MTH_A, etc.)
- `passthrough` — passes ARKit shape names through unchanged

**Accumulation**: multiple ARKit shapes can map to the same target with weights. They sum, then clamp to [0, 1].

**Default-expression baseline (frontend)**: `Viewport.tsx` applies the avatar node's `properties.defaultExpressions` as a per-frame baseline (`expressionManager.setValue`) *before* overlaying the broadcast blendshapes, so live producers override defaults per-key and defaults re-assert when the bus emits an empty record. See [frontend.md](frontend.md).

**Key mappings (expressions mode)**:
- `eyeWideLeft/Right` → surprised (0.2 each)
- `mouthSmileLeft/Right` → happy (0.3 each)
- `mouthFrownLeft/Right` → sad (0.5 each)
- `browInnerUp` → surprised (0.6)
- `browDownLeft/Right` → angry (0.5 each)

## VMC pose application — `Viewport.tsx` (useFrame)

The frontend maintains `VmcRetarget` state per avatar:
```ts
{
  bonesInOrder:   VRMHumanBoneName[]          // depth-sorted, parent before child
  vrmBoneObj:     Map<name, THREE.Object3D>
  vrmBoneParent:  Map<name, parent name>
  vrmBindWQ:      Map<name, Quaternion>       // T-pose world rotations
  vrmBindWQInv:   Map<name, Quaternion>       // precomputed inverses
  curUnityWQ:     running accumulator         // world Qs being built this frame
  curVRMWQ:       running accumulator
}
```

Per frame:
1. Low-pass filter each incoming bone rotation (OneEuroFilter)
2. Apply arm reach calibration if active (correct wrist position, run IK)
3. Blend with animation: slerp each bone toward the animation pose by `(1 - blendWeight)`. Ramp speed is `1 / blendTime` seconds.
4. Write final rotations to `vrm.humanoid.setNormalizedPose()`

**Blend ramping**: `blendWeight` moves toward 0 (animation) or 1 (VMC) each frame at `1/blendTime` rate. Prevents pops when mocap drops in/out. Default `blendTime`: 0.3s.

**Pose timeout**: If no VMC frame has been received for `poseTimeout` seconds (default 2s), blend weight ramps back to 0. OneEuroFilter resets to prevent stale filtered values carrying over when mocap reconnects.

## Two clip systems

This module covers `animation_clips` — imported FBX/BVH clips retargeted to VRM and played via Three.js `AnimationMixer`. A second, unrelated clip system also exists: `track_clips` (see [track-clips.md](track-clips.md)), authored in the editor timeline to animate scalar params on scene nodes / compose layers via a frontend rAF evaluator. The two share no storage, no playback machinery, and no UI surface.

## Animation clip DB — `animation_clips` (migration 001)

```sql
CREATE TABLE animation_clips (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  source_node_id  TEXT NOT NULL REFERENCES scene_nodes,  -- avatar node
  source_file_path TEXT NOT NULL,
  clip_index      INTEGER NOT NULL,   -- which clip in file (multi-clip FBX)
  label           TEXT NOT NULL,
  start_time      REAL NOT NULL,      -- trim in point (seconds)
  end_time        REAL NOT NULL,      -- trim out point (seconds)
  duration        REAL NOT NULL,      -- trimmed duration
  fps             REAL NOT NULL,
  created_at      TEXT NOT NULL
);
```

Index on `source_node_id`. FK cascade delete when the avatar node is deleted.

FBX files can contain multiple named takes; `clip_index` selects which one. `start_time`/`end_time` allow trimming without re-exporting.

## VRM skeleton parsing — `vrm/skeleton.ts`

`loadVrmSkeleton(filePath)` parses a GLB/VRM file without an external renderer. Returns `VrmSkeletonData`:

```ts
Record<vrmBoneName, {
  localTranslation: [x, y, z]    // rest position relative to parent
  localRotation:    [x, y, z, w] // rest rotation in parent space
  parent:           string | null
}>
```

Supports VRM 1.0 (`VRMC_vrm.humanoid.humanBones` as `Record<name, {node}>`) and VRM 0.x (`VRM.humanoid.humanBones` as `Array<{bone, node}>`). Used server-side by `arm_ik_calibration` for FK computation and IK solving.

## PropertiesPanel — animation clip UI

The Animation section in `PropertiesPanel.tsx` shows:
- List of `animation_clips` for the selected node
- Per-clip: label, trim in/out points, fps display
- Playback: play/pause/loop controls, current time scrubber
- Add clip: triggers FBX/BVH file selection → `POST /scene-nodes/:nodeId/clips`

## Hard-won correctness notes

| Issue | Cause | Fix |
|-------|-------|-----|
| All rotations wrong | wxyz/xyzw mismatch | Everything uses xyzw; never swap |
| VMC arms/hands flipped | RhyLive left-handed convention | Y/Z negate in rhylive_bone_mapper |
| UE4 FBX character lies on side | Z-up source, Y-up target | Detect from spine direction; apply axis correction to fbxBindWQ |
| T-pose vs A-pose drift | VRM T-pose ≠ FBX A-pose | Compute vrmAposeWQ per-bone and use in delta calculation |
| Frame 0 drift on UE4 retargets | FBX frame 0 ≠ bind pose | Use frame 0 as reference, not bind pose |
| Hand fingers point wrong direction | Palm chirality mismatch | Canonicalize palm normal before basis alignment |
| Animation pops at loop point | First and last keyframe identical, single-frame hold | Trim duration to second-to-last keyframe |
| Blendshapes exceed 1.0 | Multiple ARKit shapes accumulate to same target | Clamp after accumulation, not per-mapping |
| Morph targets stomped by expressions | VRM expressionManager also writes morphs | Apply expressions first, then write direct morph target overrides |
