# Learned Tracking (`learned_tracker`)

Webcam body tracking with a learned model. vspark runs the **motiontracker runtime**
(`mtservice`: camera → MediaPipe Holistic → learned body model → VRM bone rotations) as a child
process and receives its output as VMC over UDP on the normal 3D VMC pipeline. Drives torso, head,
shoulders and arms; no hands/fingers, face or expressions (combine with other behaviors for those).

Status: **implemented** on `feature/learned-tracker` (backend a50750b, frontend a78cd6d).

Related: [component-managers.md](component-managers.md#vmcmanager--vmc_receivermanagerts) (the
manager that runs it), [mediapipe-tracker.md](mediapipe-tracker.md) (the in-browser camera
tracker; see [Camera](#camera)), [i18n-help.md](i18n-help.md) (help anchor `behaviors#learned`).
Runtime side: motiontracker repo, `service/README.md` (setup, CLI, stdio protocol, VMC output) and
`service/src/mtservice/cli.py` (full command/event list).

## Decisions

**Decided** (owner, 2026-11-12):

- The runtime is **not bundled** into vspark. It is loaded lazily from a local motiontracker
  checkout and started with `uv`, which installs its Python environment on first use.
- It is its **own behavior kind**, so it feels native (not a configuration of the VMC receiver).
- **VMC** is the transport for pose data.
- **Control runs over stdio** (JSON lines on the child's stdin/stdout).
- vspark's frontend **One Euro render filter stays on** for it for now (see
  [animation.md](animation.md); the runtime itself sends unsmoothed output at 10 FPS).

Everything below describes the current implementation.

## Files

- `packages/backend/src/behaviors/learned_tracker/runtime.ts` — `LearnedRuntime` (one child
  process per behavior), `RuntimeStatus`, `learnedRuntimeDir()` (checkout lookup),
  `isRuntimeDir()`, `uvCommand` (the spawn command; a `CommandBuilder` is injectable for tests).
- `packages/backend/src/behaviors/vmc_receiver/manager.ts` — the `learned_tracker`
  `@BehaviorKind` declaration, `LEARNED_TRACKER_PORT`, `VMC_MANAGER_KINDS`, `_applyRuntime`,
  `_avatarFilePath`, the `/MT/Present` handler.
- `packages/backend/src/behaviors/templates.ts` — `learned_tracker` → graph prefix
  `learned-tracker:`, same `VMC_PIPELINE_TEMPLATE` as `vmc_receiver`.
- `packages/backend/src/routes/learned-tracker.ts` — `GET /api/learned-tracker/cameras`.
- Kind lists that include it: `behaviors/refresh.ts` (`refreshVmc`), `index.ts` (startup
  `syncBehaviors` query), `routes/signal.ts` (`_stripPrefix` prefixes).
- Frontend: `LearnedTrackerProps` in `components/editor/PropertiesPanel.tsx`;
  `TrackingStatus.runtime` / `LearnedRuntimeStatus` in `mesh/hooks.ts`;
  `api.getLearnedTrackerCameras` in `api/client.ts`; icon `BrainCircuit` in
  `components/icons.tsx`; connection dot in `SceneGraph.tsx`; `Viewport.tsx` counts it as a
  pose-driving behavior (`vmcComp`) alongside `vmc_receiver` and `mediapipe_tracker`.
- i18n/help: `kinds.json`, `properties.json` (`learned.*`, `help.learnedTracking`),
  `help/content/{en,de}/behaviors.md` section `{#learned}`.
- Tests: `packages/backend/test/learned_tracker.runtime.test.ts` (a fake runtime script speaking
  the protocol: start/ready/status, live camera/avatar changes, restart on port change, crash +
  restart, stop, missing checkout, missing executable, env override) and the
  `VmcManager /MT/Present` block in `managers.test.ts`.

## How it relates to VmcManager

`learned_tracker` is the third kind `VmcManager` runs (`VMC_MANAGER_KINDS`: `vmc_receiver`,
`vmc_receiver_2d`, `learned_tracker`). Per behavior, `syncBehaviors` does what it does for a 3D VMC
receiver (load the avatar skeleton, `startReceiver(id, port)` on the shared UDP socket pool, build
the graph from the stored/template program) and additionally calls `_applyRuntime`, which creates
the behavior's `LearnedRuntime` on first sight and passes it the current options:

- `runtimeDir` — `learnedRuntimeDir()`
- `camera` — `config.camera` (rounded, ≥ 0)
- `port` — `config.port`, default `LEARNED_TRACKER_PORT` = 39541 (not 39539, so it can run next to
  a VMC receiver on its default port)
- `vrmPath` — the avatar scene node's `file_path` made absolute (`join(process.cwd(), …)`), or
  null. The runtime reads the avatar's rest pose from this file.

`stopReceiver` stops and drops the runtime along with the receiver.

From the UDP side on, it is an ordinary VMC receiver: packets go through `vmc_packet_source →
rhylive_bone_mapper → body_calibration → arm_ik_calibration → eye_range_map → pose_broadcast`
(graph id prefix `learned-tracker:`). It was checked end to end by hand with the real runtime on a
video: the poses coming out of `rhylive_bone_mapper` matched the runtime's output.

**Tracking on/off** comes from motiontracker's `/MT/Present` flag (handled for any VMC kind):
`1` clears `quietSince` and sets tracking on; `0` stamps `quietSince`, and the existing 250 ms
`checkTimeouts()` sweep turns tracking off once the avatar's grace period has passed (same path as
the `/Body` frame-diff, see component-managers.md). The connection dot comes from packets arriving
(`lastSeen`), as for the other UDP receivers. `/MT/Conf` (per-joint confidence) is sent by the
runtime but not read by vspark today.

Observation (not a decision): plain `/VMC/Ext/Bone/Pos` carries no tracking signal and the `/Body`
frame-diff is RhyLive-only, so a VMC sender that sends neither `/Body` nor `/MT/Present` never turns
tracking on. That gap predates this feature and is unchanged for other VMC apps.

## Runtime process (`LearnedRuntime`)

Started as:

```
uv run --project <checkout>/service mtservice --stdio --camera <N> --vmc 127.0.0.1:<port> [--avatar-vrm <file>]
```

Protocol summary (authoritative: motiontracker `service/README.md` and `service/src/mtservice/cli.py`):

- **Commands** (vspark → stdin): `{"cmd":"camera","index":N}`,
  `{"cmd":"avatar","vrm_path":…}` or `{"cmd":"avatar","rest_positions":null}` (default rest pose),
  `{"cmd":"stop"}`. The runtime also has `cameras`, unused by vspark (the camera list goes through
  `--list-cameras`, below).
- **Events** (stdout, one JSON object per line): `ready` (carries `model.run`), `status` (about
  once a second: `fps`, `latency_ms`, `detect_ms`, `model_ms`, `present`), `error` (`message`),
  `stopped`. Non-JSON lines are ignored.
- stderr: lines starting `[mtservice]` are forwarded to vspark's log; the last 20 lines are kept
  for the crash message (MediaPipe's native `W0000`/`I0000` lines are filtered out of it).

Option changes (`apply`): `camera` and `vrmPath` go to the running process over stdin; a new `port`
or `runtimeDir` restarts it. Stopping sends `stop`, closes stdin (the runtime exits on stdin EOF,
so it never outlives vspark), then SIGTERM after 3 s and SIGKILL 3 s after that if it hangs.

Unexpected exit: restart with backoff 2 s / 5 s / 10 s / 30 s (the last repeats); a run longer than
60 s resets the backoff. A failed spawn (`uv` missing → ENOENT) is handled like a crash. A missing
checkout (`service/pyproject.toml` not found) is reported as an error without spawning; the next
`syncBehaviors` pass tries again.

## Runtime status

`LearnedRuntime` publishes every change via `publishTracking({ behaviorId, runtime })`, i.e. as the
`runtime` field of the behavior's tracking document in the `server_status` collection (see
[mesh.md](mesh.md#runtime-state-the-runtime-channel)). Fields (`RuntimeStatus`, mirrored by the
frontend's `LearnedRuntimeStatus`):

| Field | Meaning |
|-------|---------|
| `state` | `starting` / `running` / `error` / `stopped` |
| `message` | error text, or what a slow start is doing (first start: uv installs the runtime, can take minutes) |
| `fps` | frames processed per second (runtime target 10) |
| `latencyMs` | camera capture → bones sent, ms (may be null) |
| `detectMs` | MediaPipe detection time per frame, ms |
| `modelMs` | learned model + conversion time per frame, ms |
| `present` | share of frames with a detected body, 0..1 |
| `model` | model run name from the `ready` event |

The properties panel shows these as a status line (state colour, fps, latency, model time, errors).

## Configuration

Behavior config (`defaultConfig`): `{ camera: 0, port: 39541, mirror: false }`. The properties panel
edits `camera` (select filled from the runtime's camera list, with a Refresh button; the configured
index stays selectable when the list lacks it) and `port`, and shows the VMC `CalibrationSection`
on the `learned-tracker:` graph.

Checkout location (`learnedRuntimeDir()`), first match wins:

1. env `VSPARK_MOTIONTRACKER_PATH`
2. `learnedTracker.runtimePath` in `config.json` (`VSPARK_CONFIG_PATH` or `<install dir>/config.json`;
   relative paths resolve from the install dir)
3. the nearest `motiontracker` folder containing `service/pyproject.toml` beside the install dir or
   any of its parents (in dev the install dir is `packages/backend`, so `~/projects/motiontracker`
   next to the vspark repo is found)
4. fallback `<install dir>/../motiontracker` (reported as missing if it isn't a checkout)

The runtime also needs `uv` on PATH and an exported model bundle in the checkout (motiontracker
`service/README.md`, Setup).

## Camera list route

`GET /api/learned-tracker/cameras` runs `uv run --project <checkout>/service mtservice --list-cameras`
(timeout 5 min, since the first call may install the runtime) and returns
`{ ok: true, data: { cameras: [{ index, name }] } }` from the last stdout line. Failures (uv missing,
checkout broken, unparseable output) return 502 `RUNTIME_UNAVAILABLE` with a message.

## Camera

The runtime opens the webcam itself (OpenCV in the child process), not through the browser. The
in-browser [MediaPipe tracker](mediapipe-tracker.md) and Learned Tracking can't use the same webcam
at the same time; the help page tells the user to turn off camera tracking on that webcam. Nothing in
vspark detects or prevents the conflict today.

## Open points

- Not merged to `dev` yet.
- `/MT/Conf` confidences are not consumed.
- The motiontracker OSC namespace (`/MT/*`) is marked provisional on the runtime side.
