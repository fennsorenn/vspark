# Animation

Covers FBX/BVH retargeting to VRM, VMC live pose application, blendshape mapping, animation clip playback, and the signal graph nodes that sit in the pipeline.

## Overview

Two animation sources can drive a VRM avatar simultaneously, blended per-bone:

1. **Clip animation** — FBX or BVH file retargeted to VRM, played via Three.js `AnimationMixer`
2. **Live mocap** — VMC (RhyLive) or MediaPipe pose, processed server-side through the signal graph and broadcast as `NormalizedPose` over WebSocket

Both produce per-bone world-space quaternions. The blend weight ramps smoothly between them.

## Core types — `packages/shared/src/signal.ts`

**Convention: quaternions are always xyzw.** Every serialization path (JSON tuples, WS messages, DB state) uses `[x, y, z, w]`. Mixing this up with wxyz breaks all rotations silently.

**`Quaternion`**: Immutable unit quaternion. Methods: `multiply`, `invert`, `normalize`. Invalid (near-zero) quaternions normalize to `IDENTITY`. Euler bridges: `Quaternion.fromEuler(pitch, yaw, roll)` and `q.toEuler()` use the **intrinsic ZYX** convention (matching `euler_to_quaternion`); round-trip verified to ~1e-14, and `toEuler` collapses the coupled rotation onto roll at the yaw=±90° gimbal singularity. Used by `pose_manual_calibration` to apply per-axis multiply/offset.

**`BoneRotations`**: `Map<string, Quaternion>` — raw mocap data keyed by source app bone names (Unity HumanBodyBones, RhyLive format, etc.). Pre-mapping.

**`NormalizedPose`**: `Map<VRMBoneName, Quaternion>` — after mapping and coordinate correction. All downstream consumers use this.

**`VRM_BONE_NAMES`**: 55-element string array. The canonical key set for `NormalizedPose`. Covers full humanoid skeleton from hips through all finger distal bones.

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

**Root reframe (`rootParentWQ`) — version-independent facing.** Clips are authored facing world +Z (e.g. Mixamo), but a VRM's rest pose may face either way (VRM 0.x +Z vs VRM 1.0 −Z, and real models don't always honour their spec convention). Left unhandled, the hips basis alignment bakes the gross rest-vs-clip facing difference (~180° yaw) into the animation, so the avatar snaps around when a clip starts — VRM0 ended up facing the opposite way from VRM1 *during playback* even after the rest pose was corrected. The fix reuses the same yaw `faceCameraYaw` computes to bring the rest front onto +Z (`frontYawRef`): a `rootParentWQ = R_y(frontYaw)` seeds the **root** of both the bind chain (Phase 2) and the per-frame world chain (Phase 4), and its inverse re-expresses the hips position track. This reframes the whole retarget into the clip-aligned frame, so `fullRot` collapses to just the A-pose lean and the net rendered animation is `worldDelta × (camera-facing rest pose)` — identical across VRM versions. Identity (no-op) when the rest already faces +Z.

**Phase 2 — VRM bind world quaternions**

Chain `bone.quaternion` root → leaf through the VRM skeleton to get world-space T-pose rotations per bone. Bones are sorted depth-first (parent before child) so parent WQ is always available when processing a child.

**Phase 3 — A-pose correction**

VRM uses T-pose (arms parallel to shoulder line). Most FBX animations use A-pose (arms at sides, possibly bent). The algorithm computes per-bone `vrmAposeWQ` — the world rotation the VRM bone would have if it were in the FBX rig's A-pose:

- **Hips**: full 3-axis basis alignment using spine direction, left thigh direction, right thigh direction
- **Other bones**: single-axis swing to align child bone directions between FBX and VRM skeletons
- **Hands**: basis correction including chirality — palm normal (cross product of finger directions) is canonicalized (`if fU.y > 0: fU.negate()`) to ensure anatomically correct orientation regardless of whether the source is left or right handed

**Phase 4 — Per-frame retargeting**

Uses the FBX **bind pose** as the reference: `worldDelta = fbxWorldQ × fbxBindWQ⁻¹`.

> Previously documented here as "frame 0 is the reference pose, not the bind pose". That is **not** what the code does — the bake multiplies by `fbxBindWQInv`. A frame-0 reference (`fbxRefWQ` / `fbxRefWQInv`) *is* still computed in `Viewport.tsx` but is never read by the bake; it is dead code. Corrected after the stale description sent several debugging passes down the wrong path.

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

### Animation buffer — the clip mixer drives a shadow skeleton

The clip `AnimationMixer` is bound to a **`ShadowSkeleton`** (`Viewport.tsx`): a bone-only hierarchy, name-matched to the VRM's raw humanoid bones with their rest transforms copied, and *not* part of the rendered scene. Baked tracks bind to it because `AnimationMixer` resolves targets by name path (`${bone.name}.quaternion`). The composition step reads its animation baseline from those shadow bones; the real skeleton is written only by the composition, once per frame.

This exists because a bone rotation has exactly one home — `bone.quaternion` — and the composition previously used it as *both* its animation input and its output. Each frame's composed pose became the next frame's "animation" baseline. That was harmless only while the mixer overwrote the bones first, and `THREE.PropertyMixer` is **change-driven**: it caches the value it last wrote and skips the write when the newly interpolated value is identical, comparing against its own cache rather than against the bone — so it cannot see that something else clobbered it.

A clip whose playhead never advances therefore stops writing after its first frame. A **static single-keyframe pose** hits this immediately (see below), and from frame 2 the animation channel read back the composed pose, i.e. tracking. Symptom: with **Anim 1 / Track 0** a pose clip rendered the *tracked* pose, and Track 1 compounded tracking onto itself every frame. Multi-keyframe clips masked it entirely because their playhead moves.

Binding the mixer to its own hierarchy dissolves the class of bug rather than timing around it: a skipped write is now *correct* (the shadow bone retains the right pose), so static and animated clips take one identical path with no special-casing. `Object3D.quaternion` is read-only, so a parallel hierarchy is the way to hand the mixer a private buffer. Regression cover: `test/animBuffer.test.ts`.

### Static poses (single-keyframe clips)

Some exports are a *pose*, not an animation. Mixamo's "… Pose" files (e.g. `Male Sitting Pose.fbx`) contain:

- **52 quaternion tracks with exactly 1 keyframe each** — the pose itself
- **1 hips position track with 2 identical keyframes** (t=0 and t=0.0333) — the sole source of the clip's 0.0333 s duration
- a second, completely empty clip named `Take 001` (0 tracks, 0 duration) — a Mixamo export artifact present in most exports, animations included

So `refTrack.times.length === 1` and `allTimes = [0]`: the loop-clamping test never fires (`lastIdx === 0`), and `vrmDuration` computes to `min(0.0333, 0) = 0`. Both are harmless — a 1-key track holds its value and a zero-duration clip still samples correctly. What broke static poses was the shared-buffer aliasing above, which their pinned playhead exposed. They need no special handling.

> Note: the code takes `fbx.animations[0]` unconditionally. Today index 0 is the real clip, but `FBXLoader`'s ordering isn't contractual — if the empty `Take 001` ever came first, the avatar would load a clip with zero tracks and render rest.

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

Convention: ZYX intrinsic (Rz(roll) × Ry(yaw) × Rx(pitch)). Used by the breathing component to drive sine wave output into bone rotations. The shared `Quaternion.fromEuler` / `Quaternion.toEuler` helpers (`signal.ts`) follow the same ZYX convention and are used by `pose_manual_calibration`.

### Pose interceptor chain

The `pose_broadcast` node doesn't fire directly to WebSocket. It first passes the pose through a chain of registered interceptors (e.g., the breathing component, the manual_calibration behavior). Each interceptor receives the pose via `on_pose_broadcast`, modifies it, and re-emits it via `pose_interceptor_broadcast`. The chain is ordered by registration priority; the final output is what gets sent over WebSocket. The `manual_calibration` behavior (`pose_manual_calibration` node at priority 5) is an interceptor that applies a per-bone, per-axis euler multiply/offset — see [component-managers.md](component-managers.md).

## Blendshape mapping — `arkit_vrm_mapper`

**Input**: ARKit 52-shape weights (from RhyLive `/Face` messages or MediaPipe face landmarks)  
**Output**: `Blendshapes` (VRM expression names or VRoid morph target names)

Three modes:
- `expressions` — maps to VRM standard expression names (happy, sad, angry, surprised, relaxed)
- `fcl` — maps to VRoid `Fcl_*` morph target names (Fcl_EYE_Close_L, Fcl_MTH_A, etc.)
- `passthrough` — passes ARKit shape names through unchanged

**Accumulation**: multiple ARKit shapes can map to the same target with weights. They sum, then clamp to [0, 1].

**Default-expression baseline (frontend)**: `Viewport.tsx` applies the avatar node's `properties.defaultExpressions` as a per-frame baseline (`expressionManager.setValue`) *before* overlaying the broadcast blendshapes, so live producers override defaults per-key and defaults re-assert when the bus emits an empty record. See [frontend.md](frontend.md).

**Live mapper-config edits (frontend release)**: editing this behavior's `nodeConfig.arkit_*_cfg.mapping` / `enabled` hot-applies on the backend and can change the *set* of output target keys mid-stream. `Viewport.tsx` tracks the expression/morph keys it drove last frame and resets dropped ones to 0, so a removed target releases instead of freezing at its last value (three-vrm persists unset weights). See [frontend.md](frontend.md) (Stale-key release).

**Key mappings (expressions mode)**:
- `eyeWideLeft/Right` → surprised (0.2 each)
- `mouthSmileLeft/Right` → happy (0.3 each)
- `mouthFrownLeft/Right` → sad (0.5 each)
- `browInnerUp` → surprised (0.6)
- `browDownLeft/Right` → angry (0.5 each)

## Avatar facing — `faceCameraYaw` (`Viewport.tsx`)

On load, each avatar is yawed to face the camera (world +Z). VRM 0.x rigs face +Z and VRM 1.0 rigs face −Z by spec, so the old blanket `vrmScene.rotation.y = Math.PI` only ever suited one convention (the other faced away). `faceCameraYaw(vrm, vrmScene)` instead derives the avatar's **actual** front from its rest-pose skeleton — `(leftUpperArm − rightUpperArm) × (hips → head)`, read in `vrmScene`-local space — flattens it to the XZ plane, and returns the yaw that rotates that front onto +Z. This is deliberately geometry-based rather than branching on `vrm.meta.metaVersion` / `VRMUtils.rotateVRM0`, because real-world models frequently don't honour their version's spec convention. Yaw-only (matching the prior behaviour); falls back to `Math.PI` if the needed bones are missing. The computed yaw is stashed on `frontYawRef` and reused by the FBX retarget's root reframe (see `rootParentWQ` under FBX/BVH retargeting) so clip playback faces the same way as the rest pose.

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
1a. Optional **motion snappiness** — a per-bone second-order dynamics (spring–damper) filter layered *after* the One Euro filter. Off by default; gated on `node.properties.poseDynamics.enabled`. See "Motion snappiness" below.
2. Apply arm reach calibration if active (correct wrist position, run IK)
3. Blend with animation: slerp each bone toward the animation pose by `(1 - blendWeight)`. Ramp speed is `1 / blendTime` seconds.
4. Write final rotations to `vrm.humanoid.setNormalizedPose()`

**Blend ramping**: `blendWeight` moves toward 0 (animation) or 1 (VMC) each frame at `1/blendTime` rate. Prevents pops when mocap drops in/out. Default `blendTime`: 0.3s.

**Pose timeout**: If no VMC frame has been received for `poseTimeout` seconds (default 2s), blend weight ramps back to 0. OneEuroFilter resets to prevent stale filtered values carrying over when mocap reconnects.

### Tracking ↔ animation stacking + partial tracking

**Status:** implemented. Frontend-only, per-avatar-node. Stacking is the **universal tracked-avatar path**; partial-tracking sliders are off (all-`{anim:1, track:1}`) by default.

**Stacking model.** In `override` blend mode the tracked avatar no longer full-overrides the animation (`setNormalizedPose`) and no longer runs separate per-section branches — both were unified into one per-bone **stacking** loop. Per bone: start from the rest pose, blend toward the (base) animation by the section's **Anim** influence, then stack the tracking **delta** (tracking taken relative to rest) scaled by the section's **Track** weight on top. Each layer is scaled independently, so both sliders always affect the result. Corners:

- Anim 1 / Track 0 → animation only
- Anim 0 / Track 1 → tracking only
- Anim 0 / Track 0 → rest
- Anim 1 / Track 1 → base animation with full tracking stacked (the legacy default, `DEFAULT_SECTION_INFLUENCE`)

The per-bone math is a pure, unit-tested helper — **`packages/frontend/src/components/editor/poseComposition.ts` (`stackBoneRotation`)**, tested in `packages/frontend/test/poseComposition.test.ts`. Change or verify the blend math there, not inline in `Viewport.tsx`.

`final = slerp(rest, animQ, animInf) · slerp(identity, rest⁻¹·trackedQ, trackWeight)`. `trackWeight` is pre-clamped and already folds in the global transition ramp (`Track × blend`); an untracked bone (`trackedQ` null) drops the tracking term and follows the scaled base animation alone. `animQ` is the base-animation pose while a clip is driving, else `rest` (so `Track 0` doesn't freeze the last tracked pose). The explicit `poseMode === 'additive'` branch is unchanged.

**Partial tracking (per-section blend).** A per-avatar-node `poseSource` property (`SceneNodeProperties.poseSource`, types `PoseSource` / `PoseSection` / `PoseSectionInfluence` — see [shared-types.md](shared-types.md)) scales the Anim/Track layers **independently per body section**: `head`, `gaze`, `body`, `arms`, `hands`, `legs`, each with an `anim` and a `track` influence in `0..1`. Typical use: play a full-body clip for the legs while live tracking drives the upper body. A static `BONE_TO_SECTION` map (`Viewport.tsx`, built from `POSE_SECTION_BONES`; unlisted bones fall under `hands`/fingers) assigns every VRM humanoid bone to a section; absent sections resolve to `{anim:1, track:1}`, so an unset `poseSource` changes nothing.

**No-feed branch — idle plays straight.** With **no live tracking feed** (signal lost, or no enabled tracking source at all) the idle animation plays at **full strength**: the branch composes with `animInf = 1`, `trackedQ = null`, `trackWeight = 0`, and root motion at `legsAnim = 1`. The partial-tracking levers describe how tracking blends against the *base* animation while a source is live; with nothing tracking there is nothing to weigh the idle against, so they do not apply here. Nothing else is applied either — ambient producers (Breathing) merge into the **tracked** pose only, never into a straight idle.

**Branch selection keys off `trackingLive`, not bus-pose presence.** Step 2's gate is `trackingLive && blend > 0 && pose`. The `trackingLive` term is essential: ambient producers publish additively and forever (Breathing's `pose_broadcast` runs at priority 10 with `animationBlendMode: 'additive'`, independent of tracking), so `pose` stays non-null and `poseActive` stays true for the lifetime of the behavior. Gating on those alone ran the weighted tracked path permanently and made the untracked idle branch unreachable whenever a Breathing behavior was attached — the originally-reported "idle still goes through the weights". For the same reason `targetWeight` (the blend ramp) and the filter-reset transition both key off `trackedComposeActive = trackingLive && poseActive` rather than `poseActive`, which an ambient producer would otherwise pin true forever.

> **Known regression — no cross-fade on tracking loss.** Because the gate includes `trackingLive`, the tracked branch is skipped the instant tracking drops, so `blend` ramps down against a branch that no longer runs: the tracked→idle handover is a hard cut. Intended behaviour is a `blendTransitionTime` cross-fade between straight idle and weighted base+track. Fixing it means keeping the tracked branch alive while `blend > 0` and blending its output against the straight idle rather than switching between them. Deliberately deferred (lowest priority).

This branch was originally a **slider-preview** path — gated on `poseSourceIsActive` (true only when some lever was off-default) and scaling the idle by each section's Anim influence, so moving a lever visibly drooped a section toward rest with nothing connected. That made it load-bearing for ordinary idle playback while carrying a gate unrelated to it: with every lever at default the branch was skipped entirely and the idle fell through to whatever the Step 1 mixer had left on the bones — no `resetNormalizedPose`, no normalization — so whether the idle was properly composed depended on whether a lever had been touched. The gate and the scaling are both gone; the branch now runs on every untracked frame (`else if (vrm)`) and `poseSourceIsActive` was deleted.

> Driving the **legs** from tracking needs a full-body VMC source — webcam MediaPipe tracking doesn't send legs.

**Base animation slot.** `properties.animation.base = { url?, clipId?, speed? }` is a second clip slot distinct from `properties.animation.idle`. While a live tracking source is connected the **base** animation drives the anim layer (the loop tracking stacks onto); when tracking is lost/absent the avatar falls back to the **idle**. If `base` is unset, `idle` doubles as the base. The base⇄idle swap is driven by a reactive `trackingActive` flag set from the per-frame pose loop (`Viewport.tsx`, `AvatarNode`); `base` is resolved by `url` (or `clipId` if present) and passed as the idle arg to `_resolveAvatarAnimation`. Scheduled clips still win over both. Persisted via `schema.ts` (`animationSlotSchema = {clipId?, url?, speed?}` on `sceneNodePropertiesSchema.animation.{idle,base}`, `.passthrough()` to keep legacy sub-fields — a prior strict-object path was stripping the unknown `animation` key).

UI: a "Partial Tracking" section in the PropertiesPanel avatar block (per-section `anim`/`track` sliders `vs-posesrc-anim-*` / `vs-posesrc-track-*`, a `vs-posesrc-reset`) plus a **Base Animation** picker in the Animation section (`vs-base-anim-url` / `vs-base-anim-clear` / `vs-base-anim-speed`), EN/DE i18n under `avatar.poseSource*` / `properties.avatar.baseAnimation` + `help.poseSource` / `properties.help.baseAnimation`, and an updated `{#partial-tracking}` help section in `avatar.md`.

### Motion snappiness (second-order dynamics)

**Status:** implemented (2026-06-19). Frontend-only, per-avatar-node, disabled by default.

A configurable second-order dynamics (spring–damper) filter applied per bone to the broadcast pose, layered **after** the One Euro filter rather than replacing it. The One Euro filter stays responsible for jitter and uneven/low-frequency packet delivery; the dynamics layer adds "snap"/"follow-through". Unlike a low-pass filter (which can only lag the target), a second-order system can **lead and overshoot** the target, so motion reads as snappy without going choppy (output stays C¹-continuous).

**Why frontend, not a backend pose-interceptor.** The deliberate placement is the frontend avatar node, not the backend `on_pose_broadcast`/`pose_interceptor_broadcast` chain, because the One Euro filter must stay in place at the consumer to absorb unreliable/low-frequency packet delivery — the dynamics layer assumes an already-de-jittered, frame-rate-paced input.

**Module:** `packages/frontend/src/secondOrderDynamics.ts` — exports `SecondOrderDynamicsQuat` (single-bone filter), `BoneDynamicsBank` (one lazily-created filter per bone name, `.reset()` resets all), `PoseDynamicsConfig`, and `DEFAULT_POSE_DYNAMICS` (`{ enabled: false, frequency: 3.0, damping: 0.6, response: 1.2 }`).

**Math.** The standard semi-implicit-Euler second-order formulation (t3ssel8r, "Giving Personality to Procedural Animations using Math") adapted from scalar to SO(3): spring error, target velocity, and output velocity are all world-frame rotation vectors (axis·angle), and the output orientation is integrated through the quaternion exponential map. `k2` is stability-clamped so the integrator stays stable at large `dt` (low frame rates). Parameters:
- `frequency` (Hz) — natural frequency; higher = quicker reaction / snappier.
- `damping` (ζ) — `<1` overshoots (snap/bounce), `1` critical (no overshoot), `>1` sluggish.
- `response` (r) — `0` no anticipation, `>0` anticipatory lead, `<0` winds up before moving.

**Wiring** (`Viewport.tsx`, `AvatarNode` `useFrame`, Step 2 broadcast pose composition): a `boneDynamicsRef` (`BoneDynamicsBank`) runs immediately after the `boneFiltersRef` One Euro `BoneFilterBank`. Reads `node.properties.poseDynamics ?? DEFAULT_POSE_DYNAMICS`; when `enabled` is false the bank is `.reset()` each frame so re-enabling starts cleanly from the current pose.

**Config** is persisted as the per-node `poseDynamics` property: typed as `PoseDynamics` on shared `SceneNodeProperties` (`packages/shared/src/types.ts`), Zod-validated in `sceneNodePropertiesSchema` (`packages/shared/src/schema.ts`), and mirrored in both frontend `NodeProperties` interfaces (`store/editorStore.ts`, `api/client.ts`). UI is a "Motion Snappiness" section in the PropertiesPanel avatar block (enable checkbox + frequency/damping/response `NumInput`s + `HelpButton`). i18n keys under `avatar.*` and `help.dynamics` in `properties.json`; help section `{#snappiness}` in `help/content/{en,de}/avatar.md`.

## Shared, scheduled, content-addressed playback

**Status:** implemented (2026-06-13). See [plans/avatar-animation.md](../plans/avatar-animation.md) for the design + deferred items.

An avatar's clip animation is **collab-shared and clock-anchored** rather than free-running per client. Two layers, both content-addressed by `animation_clip` id (clip ids are universal across peers; the source FBX/BVH transfers by hash via the mesh asset follow-up, and the clip row carries `duration`):

- **Idle (base loop)** — avatar node state: `properties.animation.idle = { clipId, speed }`. Anchored to epoch 0 so every client shares the same loop phase.
- **Schedule (priority timeline)** — a synced doc collection `scheduled_animation` (a per-avatar timeline of clip entries; same pattern as `track_clip`/`animation_clip` — parents to the avatar node, rides its subtree subscription, never appears in the scene tree).

### `scheduled_animation` rtype

Migration `033_scheduled_animations`: `id, avatar_node_id (FK→scene_nodes ON DELETE CASCADE), clip_id, start_epoch, speed, loop, created_at`. Resource descriptor (load/save/remove) in `packages/backend/src/sync/resources.ts`; mesh binding in `packages/backend/src/mesh/index.ts` (`parent → scene_node:avatarNodeId`, `persists` when the avatar row exists). Frontend: a `scheduledAnimations` store slice fed by the mesh feeder (`sync/meshStoreFeeder.ts`), plus a `PARENTS`/`RTYPES` entry. See [mesh.md](mesh.md) for the collection mechanics.

**Clock localization.** `start_epoch` is anchored on the *author's* mesh clock. The collection's `validate(data, originId)` translates a foreign doc's `startEpoch` onto the receiver's clock via the mesh peer-clock API `peer.toLocalTime(originId, startEpoch)`. This is the general mechanism for localizing peer-relative fields; the mesh threads `originId` (the origin peer id) into `validate` for local writes, remote ops, and snapshots — see [mesh.md](mesh.md) (peer-clock localization). The clock is a synchronized-clocks stub today, so the translation is numerically a no-op, but the call sites are final.

### Frontend clock-anchored driver — `Viewport.tsx` (AvatarNode)

The old free-running mixer advance (`mixer.update(delta)`) + one-shot seek is replaced by a two-layer resolver stepped with `update(0)` so the mixer never free-runs:

- `_resolveAvatarAnimation` picks the active layer: the latest-started `scheduled_animation` entry still inside its window (`startEpoch ≤ syncedNow`, and for a non-loop finite entry `startEpoch + duration/speed > syncedNow`), else the idle base loop.
- `_anchoredTime` computes each action's playhead from the active layer against the synced clock (`Date.now()`): `action.time = (syncedNow − activeStartEpoch) · speed`, mod duration (loop) or clamped (non-loop hold). The idle loop anchors to epoch 0 for a shared phase.

A clipId is resolved to a localized source URL + duration through the `animationClips` + `scheduledAnimations` store slices fed by the mesh feeder; `animRegistry` gained `vrmDuration` for the lookup.

### Idle migration (content-addressed)

Idle moved from the legacy `components.animation.idleUrl` to `properties.animation.idle = { clipId, speed }` (typed on `NodeProperties` in `api/client.ts` + `editorStore.ts`). A frontend **lazy migration** in Viewport upgrades existing avatars once the matching `animation_clip` is registered (the resolver falls back to the legacy URL until then). The PropertiesPanel idle picker reads either shape; **editing always writes the legacy shape + clears the migrated idle**, so the migration re-derives a fresh clip id (single edit path). The offset field and the local pause/seek/stop transport controls were removed — playback is now driven by the synced timeline, so the panel transport is reduced to speed.

The `api_controller` behavior PROJECTS its animation queue onto this timeline; the old `api_animation` WS path is retired. See [api-controller.md](api-controller.md).

### Deferred

Crossfade/blend between clips; a global timeline transport (pause/seek over the whole schedule); preload of upcoming clips before their start; two-backend collab clock-sync verification (the clock is a synchronized stub today). Tracked in [plans/avatar-animation.md](../plans/avatar-animation.md).

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
- Add clip: triggers FBX/BVH file selection → `POST /scene-nodes/:nodeId/clips`

The avatar idle picker writes `properties.animation.idle = { clipId, speed }` (speed only — the offset field and the local pause/seek/stop transport were removed under the synced-timeline model). See the shared/scheduled playback section above.

## Hard-won correctness notes

| Issue | Cause | Fix |
|-------|-------|-----|
| All rotations wrong | wxyz/xyzw mismatch | Everything uses xyzw; never swap |
| VMC arms/hands flipped | RhyLive left-handed convention | Y/Z negate in rhylive_bone_mapper |
| UE4 FBX character lies on side | Z-up source, Y-up target | Detect from spine direction; apply axis correction to fbxBindWQ |
| T-pose vs A-pose drift | VRM T-pose ≠ FBX A-pose | Compute vrmAposeWQ per-bone and use in delta calculation |
| Static "… Pose" clip renders the *tracked* pose (Anim 1 / Track 0), Track 1 compounds it | Composition read its animation baseline off `bone.quaternion` — the same field it writes its output to. A 1-keyframe clip pins the playhead, the change-driven `PropertyMixer` stops writing, and the baseline reads back last frame's composed pose | Bind the clip mixer to a `ShadowSkeleton` so the animation pose has a buffer nothing else writes |
| Hand fingers point wrong direction | Palm chirality mismatch | Canonicalize palm normal before basis alignment |
| Animation pops at loop point | First and last keyframe identical, single-frame hold | Trim duration to second-to-last keyframe |
| Blendshapes exceed 1.0 | Multiple ARKit shapes accumulate to same target | Clamp after accumulation, not per-mapping |
| Morph targets stomped by expressions | VRM expressionManager also writes morphs | Apply expressions first, then write direct morph target overrides |
| VRM0 avatar faces away from camera | VRM 0.x rigs face +Z, VRM 1.0 face −Z; loader used a blanket `rotation.y = Math.PI` that only suited one convention | `faceCameraYaw()` derives the actual front from the rest skeleton (shoulder line × spine) and yaws it onto +Z — version-agnostic, no metaVersion/`rotateVRM0` branch (real models often don't honour their spec convention) |
| Avatar animation faces 180° from VRM1 / snaps when a clip starts | Hips A-pose `fullRot` baked the gross rest-pose↔clip facing difference (a ~180° yaw for VRM0 vs a Mixamo clip) into the per-frame motion | Reframe the retarget root by `rootParentWQ = R_y(frontYaw)` (the `faceCameraYaw` yaw) through the bind + per-frame chains so the whole clip is retargeted in the clip-aligned frame → `worldDelta × camera-facing rest`, identical across versions (no-op when rest already faces +Z). A frame-0-only yaw strip is NOT enough — it breaks per-frame composition and the flip returns mid-clip |
