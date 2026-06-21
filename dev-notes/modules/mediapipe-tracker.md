# MediaPipe Tracker

Browser-based motion capture using MediaPipe Holistic. The backend wires a signal
graph that converts landmark streams into VRM bone rotations, expressions, and
arm IK targets. The frontend solves the IK locally on the avatar.

Status: **implemented (upper body + face + hands)**. Open work below.

Related: [signal-graph.md](signal-graph.md), [component-managers.md](component-managers.md).

## Files

Backend:
- `packages/backend/src/behaviors/mediapipe_tracker/manager.ts`
- `packages/backend/src/behaviors/mediapipe_tracker/graph.ts`
- `packages/backend/src/signal/nodes/pose_torso_head_to_bones.ts`
- `packages/backend/src/signal/nodes/pose_arms_to_bones.ts`
- `packages/backend/src/signal/nodes/pose_ik_targets.ts`
- `packages/backend/src/signal/nodes/ik_broadcast.ts`
- `packages/backend/src/signal/nodes/hand_landmarks_to_bones.ts`
- `packages/backend/src/signal/nodes/arkit_vrm_mapper.ts` (ARKit 52-shape → VRM expressions; shared with the VMC pipeline)
- `packages/backend/src/signal/nodes/face_landmarks_to_blendshapes.ts` (registered but **no longer wired** into the default graph — kept as a manual option / for back-compat of saved graphs)
- `packages/backend/src/signal/nodes/body_calibration.ts` (extended with mirror support — see [signal-graph.md](signal-graph.md))
- `packages/backend/src/signal/nodes/hand_height_compare.ts`
- `packages/backend/src/signal/nodes/not_bool.ts`
- `packages/backend/src/signal/nodes/pose_merge.ts`

Frontend:
- `packages/frontend/src/media/CameraCapture.ts` — webcam capture, ships frames to worker
- `packages/frontend/src/media/mediapipeWorker.ts` — Worker source (TS)
- `packages/frontend/public/mediapipeWorker.js` — built classic IIFE bundle (committed)
- `packages/frontend/scripts/build-mediapipe-worker.mjs` — esbuild script; run with
  `pnpm --filter @vspark/frontend build:worker`. Output must be regenerated and committed
  when the source changes.
- `packages/frontend/src/hooks/useTrackingUplink.ts` — uplinks to WS `tracking_input`
- `packages/frontend/src/hooks/useWsSync.ts` — writes `pose_ik_targets` payloads into `ikTargetStore`
- `packages/frontend/src/components/editor/Viewport.tsx` — Step 2.5 IK solve, `_solveTwoBoneIk`
- `packages/frontend/src/components/editor/PropertiesPanel.tsx` — `MediapipeTrackerProps` (sliders + capture buttons)
- `packages/frontend/src/components/editor/Avatar.tsx` — VRM bone application

Shared:
- `packages/shared/src/types.ts` — `IkTarget`, `IkTargetFrame`, WS message kinds (`tracking_input`, `ik_targets`)
- `packages/shared/src/signal.ts` — `IkTargets`, `LandmarkList` entries in `SignalTypeMap`

## Pipeline

```
mediapipe_source
  ├─ arkit     → unpack_event → arkit_fcl  (arkit_vrm_mapper, mode=fcl)         ┐
  │                            → arkit_expr (arkit_vrm_mapper, mode=expressions) ├─ blendshapes_sum → blendshapes_broadcast → WS vmc_blendshapes
  │                            → arkit_pass (arkit_vrm_mapper, mode=passthrough) ┘
  ├─ face      → unpack_event → (value) pose_torso_head_to_bones.face  (head tilt/turn only)
  ├─ pose      → unpack_event → pose_torso_head_to_bones        ┐
  │                            → pose_arms_to_bones (quat arms) ┤
  ├─ leftHand  → unpack_event → hand_landmarks_to_bones (L)     ├─ pose_merge
  ├─ rightHand → unpack_event → hand_landmarks_to_bones (R)     │      → head_calib  (body_calibration, HEAD_CALIB_BONES)
  │                                                             │      → finger_calib (body_calibration, FINGER_CALIB_BONES + FINGER_MIRROR_PAIRS)
  │                                                             └      → pose_broadcast → WS vmc_pose
  └─ pose      → unpack_event → pose_ik_targets ─────────────────────────→ ik_broadcast → WS ik_targets
```

### Face blendshapes (native ARKit)

Expressions are no longer geometrically estimated from face landmarks. MediaPipe's
`HolisticLandmarker` now emits the 52 native ARKit face blendshapes directly
(`outputFaceBlendshapes: true` in `mediapipeWorker.ts`); `CameraCapture` packs
`result.faceBlendshapes` (category name → score, minus `_neutral`) into
`TrackingResult.faceBlendshapes`, the uplink carries it on `TrackingInputMessage.faceBlendshapes`
(`packages/shared/src/types.ts`), and `index.ts` forwards it to
`TrackingManager.fireLandmarks`, which fires it as a new **`arkit`** (`ArkitBlendshapes`)
event via `Blendshapes.fromRecord` into `mediapipe_source`.

From there the graph routes blendshapes **exactly like the VMC pipeline**: the `arkit`
event → `unpack_arkit` → a trio of `arkit_vrm_mapper` nodes (`arkit_fcl` / `arkit_expr` /
`arkit_pass`, one per mode) → `blendshapes_sum` → `blendshapes_broadcast`. Each mapper is
independently toggleable via `behavior_config` fields
`nodeConfig.arkit_{fcl,expr,pass}_cfg.{enabled,mapping}` — **identical field names to the
VMC pipeline**, so the same expression-mapping UI controls apply to both. Defaults: `fcl`
enabled, `expressions` and `passthrough` disabled. The three mappers are summed, so enabled
modes coexist.

The face landmark stream still flows (as a pulled value) into `pose_torso_head_to_bones.face`
to drive head tilt/turn — only the *expression* estimation moved to native ARKit.

`face_landmarks_to_blendshapes` (the old hand-rolled geometric estimator) remains
**registered** but is no longer wired into the default graph; it stays available as a manual
node and keeps any saved graphs that reference it working.

### Arm mode toggle

The `useIk` behavior config flows through a `not_bool` fan-out wired to:
- `pose_arms_to_bones.enabled` (true when IK is off)
- `pose_ik_targets.enabled` / `ik_broadcast.enabled` (true when IK is on)

Only one branch produces output at a time.

### Calibration

Two `body_calibration` instances on the merged pose:

- **head_calib** — `HEAD_CALIB_BONES`: torso, head, eyes. Plain capture/reset.
- **finger_calib** — `FINGER_CALIB_BONES` with `FINGER_MIRROR_PAIRS`. Uses the
  extended `body_calibration` `mirrorPairs` config + `mirrorSource` input port so
  a one-hand capture is mirrored across L/R fingers. `hand_height_compare` is the
  helper that selects the mirror source.

Capture/reset triggers are `component_trigger` nodes. Buttons in
`PropertiesPanel.MediapipeTrackerProps` fire them via
`POST /api/signal/graphs/:id/fire`. The API dispatches by graph-id prefix to
either `VmcManager` or `TrackingManager`.

### Config injection

All knobs (IK xScale/yScale/zScale, xOffset/yOffset/zOffset, invertX/Y/Z; head
pitchGain/yawGain/rollGain/restPitch) are surfaced via `behavior_config` nodes
wired into the converter nodes' value ports. There is no `nodeConfig[nodeId]`
side-channel. The manager only injects `_behaviorConfig` for the
`behavior_config` node kind.

## Frontend IK solve (Step 2.5)

`Viewport.tsx` runs an analytical two-bone IK solver per frame for each arm with
an active IK target:

- `_solveTwoBoneIk` — operates in parent space using rest-pose bone offsets
- Source-to-avatar shoulder scaling so target reach matches the avatar's arm length
- Chest-relative target frame: targets are transformed by the avatar's chest
  world quaternion before solving (Avatar Math.PI rotation is implicit in the chest frame)
- Writes resulting shoulder/upper-arm/lower-arm quaternions into the VRM bones
  alongside the broadcast pose

`ikTargetStore` (Zustand) holds the latest `IkTargetFrame` written by `useWsSync`.

## Worker / camera

- Camera resolution: 320×240
- Inference throttled to 10 FPS
- Built as classic IIFE so it loads as a classic Web Worker (no module worker
  required). Build script: `scripts/build-mediapipe-worker.mjs`.
- Preview canvas uses CSS `scaleX(-1)` for webcam-mirror UX (display-only;
  tracking semantics are not mirrored — see open work #4).

## Adding a new converter

1. Implement a signal node in `packages/backend/src/signal/nodes/` that takes a
   landmark list (or sub-stream from `mediapipe_source`) and outputs a
   `NormalizedPose`, `Blendshapes`, or `IkTargets`.
2. Register it in `signal/registry.ts`.
3. Wire it into `mediapipe_tracker/graph.ts`: add a node entry and edges from
   `mediapipe_source` (via `unpack_event` if you want a separate trigger/value
   split), through any merge/calibration nodes, into the appropriate broadcast.
4. If the converter needs user-tunable knobs, add them to the behavior config
   schema and add a `behavior_config` node feeding the relevant value port.
5. If new UI knobs are needed, extend `MediapipeTrackerProps` in
   `PropertiesPanel.tsx`.

## Open work

1. **Blendshape configuration** — partially addressed. Expressions now come from
   MediaPipe's native ARKit blendshapes through the shared `arkit_vrm_mapper` trio
   (see "Face blendshapes" above), so the `fcl`/`expressions`/`passthrough` mode
   toggles + per-shape `mapping` config the VMC pipeline already exposes apply here
   too. A face-tracking-specific user-facing config surface (e.g. per-shape gain in
   `MediapipeTrackerProps`) is still not built.
2. **Finger config tuning** — planned. `hand_landmarks_to_bones` produces
   residual rest-pose offsets (pinky over-spread, thumb default-out). Mirror
   calibration helps but a structural fix in the converter is wanted.
3. **Framerate optimization** — planned (not urgent). Current: 10 FPS @ 320×240
   in a worker. Options: drop camera resolution further, use OffscreenCanvas
   for frame transfer, selectively disable tracks.
4. **Mirror tracking** — planned. Preview canvas uses CSS `scaleX(-1)` for UX,
   but a config-driven mirror-tracking semantic (avatar deliberately mirroring
   user gestures) is not surfaced.
5. **Lower / full body tracking** — planned. Only upper body
   (torso/head/arms/hands/fingers) is mapped. BlazePose emits legs/feet but
   they are not yet converted to VRM hip/upper-leg/lower-leg/foot bones.
