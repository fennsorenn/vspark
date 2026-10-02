# MediaPipe Tracker

Browser-based motion capture using MediaPipe Holistic. The backend wires a signal
graph that converts landmark streams into VRM bone rotations, expressions, and
arm IK targets. The frontend solves the IK locally on the avatar.

Status: **implemented (upper body + face + hands)**. Default face blendshapes are a
landmark-derived ARKit heuristic (cheap, accuracy WIP); a native HQ-face path is opt-in. Open
work below.

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
- `packages/frontend/src/media/CameraCapture.ts` — webcam capture, ships frames to worker(s); picks the blendshape source (native vs heuristic) in `_dispatch`
- `packages/frontend/src/media/arkitHeuristic.ts` — `estimateArkitBlendshapes(faceLandmarks)`: derives ARKit-named blendshape weights geometrically from Holistic's 478 face landmarks on the main thread (the **default** face path)
- `packages/frontend/src/media/mediapipeWorker.ts` — Worker source (TS); role-parameterized `'holistic' | 'face'`
- `packages/frontend/public/mediapipeWorker.js` — built classic IIFE bundle (committed)
- `packages/frontend/src/components/MediaInputWindow.tsx` — capture UI; `enableNativeFace` ("HQ face") toggle, i18n key `media:tracking.hqFaceLabel`
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

### Face blendshapes (two sources, one ARKit pipeline)

Whatever the source, face expressions arrive as **ARKit-named** blendshape weights, get packed
into `TrackingResult.faceBlendshapes` (`CameraCapture`), travel on
`TrackingInputMessage.faceBlendshapes` (`packages/shared/src/types.ts`), and are forwarded by
`index.ts` to `TrackingManager.fireLandmarks`, which fires them as an **`arkit`**
(`ArkitBlendshapes`) event via `Blendshapes.fromRecord` into `mediapipe_source`. From there the
graph routes them **exactly like the VMC pipeline**: `arkit` event → `unpack_arkit` → a trio of
`arkit_vrm_mapper` nodes (`arkit_fcl` / `arkit_expr` / `arkit_pass`, one per mode) →
`blendshapes_sum` → `blendshapes_broadcast`. Each mapper is independently toggleable via
`behavior_config` fields `nodeConfig.arkit_{fcl,expr,pass}_cfg.{enabled,mapping}` — **identical
field names to the VMC pipeline**, so the same expression-mapping UI controls apply to both.
Defaults: `fcl` enabled, `expressions` and `passthrough` disabled. The mappers are summed, so
enabled modes coexist. **The mappers are the single calibration/customization layer regardless of
which source produced the weights** — that is the whole point of converging on the ARKit name
space upstream.

There are two upstream sources; only the source differs, the backend is identical:

- **Heuristic (default).** `estimateArkitBlendshapes(faceLandmarks)` in
  `media/arkitHeuristic.ts` derives ARKit weights *geometrically* from Holistic's existing 478
  face landmarks, on the main thread, at negligible cost. This replaced an earlier default that
  ran a dedicated trained `FaceLandmarker` in a second worker — that path dropped tracking to
  ~2–4 fps because MediaPipe's WASM oversubscribes CPU threads. The estimator is written as
  independent per-shape blocks with named `TUNE` constants (`[neutral, range]` over a normalized
  facial metric) for iterative refinement. It is an intentionally rough first pass: a few shapes
  (`cheekSquint`, `noseSneer`) are cheap proxies derived from other shapes, and shapes it can't
  estimate reliably are left at 0. **Accuracy is WIP / iterating** (see open work #1).
- **Native HQ face (opt-in).** The `enableNativeFace` option on `CameraCapture` — surfaced as the
  "HQ face" checkbox in `MediaInputWindow.tsx` (i18n `media:tracking.hqFaceLabel`), **off by
  default** — spins up a second worker running the trained `FaceLandmarker`
  (`outputFaceBlendshapes: true`) for the 52 native ARKit shapes: more accurate, more CPU.
  `CameraCapture._onFaceMessage` caches its output in `latestBlendshapes`; `_dispatch` uses the
  native weights when present and falls back to the heuristic otherwise.

Note: the `HolisticLandmarker` bundle does **not** ship the blendshapes model
(`outputFaceBlendshapes` is a silent no-op on it), which is why HQ face needs the separate
`FaceLandmarker` worker rather than just toggling a Holistic option.

The face *landmark* stream still flows (as a pulled value) into `pose_torso_head_to_bones.face`
to drive head tilt/turn regardless of which expression source is active.

The backend graph and manager are **unchanged** by all of this — they already consume
`frame.faceBlendshapes` via the `arkit` event. The geometric backend node
`face_landmarks_to_blendshapes` remains **registered** but stays **unwired** in the default
mediapipe graph: it emits a mix of `Fcl`/ARKit names and is superseded by the frontend ARKit
heuristic. It is kept as a manual node and for saved-graph back-compat.

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
- `mediapipeWorker.ts` is role-parameterized (`'holistic' | 'face'`). The `holistic` worker
  (markers) always runs; the `face` worker (native ARKit blendshapes) is only spawned when **HQ
  face** is enabled. Both are instances of the same committed IIFE bundle.
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

## Tracking loss

Only one loss path exists here: the browser stops sending frames (camera off, tab
hidden, person left frame). There is no equivalent of VMC's "packets keep arriving
but stop changing" frame-diff — the camera pipeline just goes silent.

`TrackingManager.checkTimeouts()` sweeps every 250ms (`SWEEP_MS`, fixed rather than
derived from the configured window, whose minimum is 0.1s) and compares `lastInput`
against `this.graceMs(behaviorId)` → `trackingGraceMs(nodeId, TRACKING_TIMEOUT_MS)`
from `behaviors/tracking_grace.ts`. That resolves the avatar node's
`properties.trackingGracePeriod`, shared with `vmc_receiver`, falling back to the
camera-specific `TRACKING_TIMEOUT_MS = 1000` when the node carries no setting (at
~30fps a shorter default is fine).

Because the setting lives on the node rather than the behavior, MediaPipe needs no
tracking-grace control of its own, and a VMC receiver on the same avatar cannot hold
a conflicting window. See [animation.md](animation.md) (Tracking-loss grace period)
for the full model and the extension point for new tracking sources.

## Open work

1. **Face blendshape accuracy / configuration** — WIP. The default heuristic
   (`arkitHeuristic.ts`) is a rough first pass; its per-shape `TUNE` constants are expected to
   be iterated on, and proxy shapes (`cheekSquint`, `noseSneer`) want real geometric derivations.
   Expressions feed the shared `arkit_vrm_mapper` trio (see "Face blendshapes" above), so the
   `fcl`/`expressions`/`passthrough` mode toggles + per-shape `mapping` config the VMC pipeline
   exposes apply here too. The native HQ-face path exists for users who need accuracy over CPU. A
   face-tracking-specific user-facing config surface (e.g. per-shape gain in
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
