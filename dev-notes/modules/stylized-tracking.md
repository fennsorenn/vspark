# Stylized Tracking (`pose_stylizer`)

A pose **post-processor** that re-expresses accurate tracking as stylized,
whole-body motion — the way a 2D (Live2D-style) avatar is rigged, where the rig
is not bound tightly to the performer and a handful of broad parameters fan out
across the entire body.

It exists to solve two problems at once:

1. **Accurate is not the same as flattering.** Tracking moves exactly the bones
   the performer moved. A head turn moves the head and nothing else, so the body
   reads as a mannequin with a floating head.
2. **Accurate is not the same as safe.** When a tracker drops a limb for a few
   frames it produces poses no body can hold, and those go straight to the
   avatar.

Both fall out of the same design: don't copy the skeleton, **read a few drivers
off the performance and synthesize the skeleton back from them.**

Status: implemented. Related: [component-managers.md](component-managers.md),
[signal-graph.md](signal-graph.md), [animation.md](animation.md) (Motion
snappiness, which composes on top of this).

---

## Shape

```
Intercept Pose ──┬─→ Style Drivers ─→ Stylize Pose ─→ Send Intercepted Pose
                 └────────────────────↗
```

A pose interceptor (priority **8**), so it only runs while some producer — VMC,
camera tracking, anything — is broadcasting a pose for that avatar. Priority 8
puts it ahead of `manual_calibration` (5): the pose is stylized first, and any
manual per-bone trim then applies to the pose the user can actually see.

The pose is tapped twice on purpose. `Style Drivers` reads it to summarise the
performance; `Stylize Pose` needs the original as the blend base and as the
carrier for every bone the rig does not own.

| File | Role |
|---|---|
| [`packages/shared/src/style_rig.ts`](../../packages/shared/src/style_rig.ts) | The data model: driver names, `StyleResponse`, `StyleRig`, the `follow`/`counter` presets, `mergeStyleRig`, `evaluateBoneResponse`. Pure; lives in shared so the backend nodes and the properties panel read the *same* default rig. |
| [`packages/backend/src/signal/nodes/pose_style_drivers.ts`](../../packages/backend/src/signal/nodes/pose_style_drivers.ts) | Pose → drivers. Owns all the conditioning (and therefore all the glitch rejection). |
| [`packages/backend/src/signal/nodes/pose_stylize.ts`](../../packages/backend/src/signal/nodes/pose_stylize.ts) | Drivers → pose. Owns the rig evaluation, per-bone lag, and the accurate↔stylized blend. |
| [`packages/backend/src/behaviors/pose_stylizer/`](../../packages/backend/src/behaviors/pose_stylizer/) | `graph.ts` (the fixed descriptor) + `manager.ts` (lifecycle + interceptor registration). |
| `StylizedTrackingProps` in [`PropertiesPanel.tsx`](../../packages/frontend/src/components/editor/PropertiesPanel.tsx) | The UI: amount / follow-through / rest-unmapped, a Response section, and a full per-bone rig editor. |

---

## Drivers

Nine normalized scalars, all clamped to ±1 (`armL`/`armR` signed, `energy` 0..1):

| Driver | Read from | Meaning |
|---|---|---|
| `headYaw` / `headPitch` / `headRoll` | `neck · head` composed | Head orientation **relative to the torso**, ±1 at `headRange`. |
| `bodyYaw` / `bodyPitch` / `bodyRoll` | `hips · spine · chest · upperChest` composed | Torso orientation in world, ±1 at `bodyRange`. |
| `armL` / `armR` | `left/rightUpperArm` roll | Arm elevation above `armNeutral`, ±1 at `armRange`. Mirrored (the right arm's roll is negated), because the VRM rest arms point along ∓X. |
| `energy` | Total driver motion per second ÷ `energyScale` | How busy the performance is. **No stock rig entry consumes it**, but the rig editor's driver picker offers it like any other, so you can add e.g. `energy → chest roll` for a bounce that grows with activity. It is NOT reachable outside the behavior — see the limitation below. |

### The conditioning pipeline (this is the glitch gate)

```
raw angle → ÷ range → clamp ±1 → deadzone → rate limit → EMA smooth
```

- **clamp** bounds every driver, which is what ultimately bounds the output pose.
- **deadzone** pins near-neutral values to exactly 0 and rescales the remainder
  back to full range, so sensor jitter doesn't make a still performer shimmer.
- **rate limit** (`maxRate`, driver units/second) is the important one: a tracker
  that teleports a limb produces a physically impossible driver step, and
  clipping it turns a violent pop into a short, human-looking slew.
- **smoothing** is a frame-rate-compensated EMA — `smoothing` is the fraction of
  the previous value retained *per 60Hz frame* (`alpha = 1 - smoothing^(dt*60)`),
  so the feel doesn't change with the tracker's frame rate.

`maxRate: 0` freezes the drivers entirely; that is deliberate, not a divide-by-zero
guard.

---

## Presets — the two 2D-rig conventions

2D rigs are built on one of two conventions for how the torso answers the head,
and both ship as presets (`STYLE_RIG_PRESETS`, selected by the behavior's
`preset` config field; unknown/absent → `follow`):

| Preset | head driver → torso | Reads as |
|---|---|---|
| `follow` (default) | same direction | the body leans into the look; warm, engaged |
| `counter` | opposed | contrapposto / S-curve; theatrical, posed |

Note the coupling is **directional**, and the two directions are set
independently. Both presets keep the *other* coupling — body driver → head/neck —
**opposed**, so the head stays level through a torso lean. That term is what
separates "performer" from "puppet" and is not something you would want to flip.

`STYLE_RIG_COUNTER` is built as `mergeStyleRig(STYLE_RIG_FOLLOW,
COUNTER_HEAD_RESPONSE)` — the delta *is* the documentation of what differs, and
it differs only in the head-driver terms. Body drivers, shoulders, arms, lags and
modes are shared.

**The non-obvious part**: counter is not a sign flip. Negating the four torso
terms alone would take the summed head-in-world yaw from ~47° to ~13°, i.e. the
avatar would stop looking where the performer looks. So the head and neck are
scaled up to carry ~55°, netting back to `headRange`. Both presets are asserted
against the same chain-total invariant in `style_rig.test.ts`, so a future preset
cannot quietly break gaze tracking.

## The rig

`StyleRig` is `boneName → { mode, lag, drivers }`, where `drivers` maps a driver
name to `[pitchX, yawY, rollZ]` **degrees contributed at driver = 1** (the same
intrinsic-ZYX convention as `Quaternion.fromEuler` / `toEuler`).

**Modes.**

- `replace` — the bone is built entirely from the drivers and the tracked
  rotation is discarded. This is what makes the pose glitch-proof: driver ∈ ±1
  times fixed degrees is bounded by construction. Used for the spine chain, neck,
  head and shoulders.
  A replace bone is **emitted even if the tracker never sent it**, so a face-only
  source drives an entire body through this rig. (Consequence worth knowing: those
  bones then appear in the broadcast pose, so on the frontend they participate in
  tracking↔animation stacking rather than being left to the animation layer.)
- `add` — the authored offset is premultiplied onto the tracked rotation (parent
  space), so the performer's own motion survives and only gains follow-through.
  Used for the limbs. An add bone is skipped entirely when the tracker didn't
  send it — the rig never invents limb motion.

**Sign convention for left/right pairs.** A contribution describing a *global
body motion* (the torso leans, both arms swing with it) uses the **same** sign on
both sides, because it is one rotation of the whole avatar frame. A contribution
describing an *anatomically mirrored motion* (each shoulder lifting with its own
arm) **flips** sign between the sides. Both appear in the default rig, and
`style_rig.test.ts` pins them.

**Lag.** Per-bone multiplier on the behavior's base follow-through time, applied
as a first-order lag on the summed Euler triple
(`k = 1 - exp(-dt/tau)`, frame-rate independent). The stock rig staggers it down
the chain — hips 2.6, spine 2.0, chest 1.5, upperChest 1.1, neck 0.5, head 0.2 —
and that stagger is what produces the whip-and-settle that reads as alive.
Overshoot is deliberately *not* done here; the avatar's frontend **Motion
Snappiness** (second-order dynamics, see [animation.md](animation.md)) layers on
top if you want spring.

### Why the default rig is shaped the way it is

The primary chains are tuned so that, summed over the whole chain, one unit of a
head driver produces ≈`headRange` (45°) of world rotation and one unit of a body
driver ≈`bodyRange` (25°). That keeps "stylized" from also meaning "no longer
looking where you're looking" — the head still lands on target, it just gets
there through the whole body. Both invariants are asserted in
`packages/shared/test/style_rig.test.ts`, so retuning the table can't silently
break them.

The rest is styling: head and neck counter-rotate against torso lean (gaze stays
level — the single term that does most of the work), shoulders lag behind a
torso turn, each shoulder lifts with its own arm, and the arms pendulum against
the torso.

**Merging.** Overrides merge over the **selected preset**, not always over
`follow` — switching preset re-baselines every bone the user has not overridden.
Overridden bones keep their stored numbers (they were seeded from whichever
preset was active when they were edited); resetting a bone picks the new preset
up. `mergeStyleRig(base, overrides)` merges per bone *and per driver*,
so a stored override only carries what the user changed. A driver zeroed to
`[0,0,0]` is pruned, and a bone whose drivers all end up pruned is dropped
entirely — that is how the UI's "switch this bone off" round-trips.

---

## Behavior config

```jsonc
{
  "amount": 1,           // 0 = accurate passthrough, 1 = fully stylized (slerp blend)
  "lag": 0.08,           // base follow-through seconds; × the rig's per-bone lag
  "restUnmapped": false, // send bones the rig doesn't own back to rest (glitchy fingers)
  "preset": "follow",    // 'follow' (torso moves with the head) | 'counter' (against it)
  "response": { "headRange": 45, "bodyRange": 25, "armRange": 90,
                "armNeutral": -60, "deadzone": 0.03, "maxRate": 5,
                "smoothing": 0.35, "energyScale": 4 },
  "rig": null            // null = the preset verbatim; else per-bone/per-driver overrides
}
```

Every field is surfaced through a `behavior_config` node wired into the graph
(visible on the canvas, not a hidden config read), and node config resolves live
per access, so properties-panel edits hot-apply without a graph rebuild.

---

## Implementation notes

**Per-frame state lives on the node instance, not in `setState`.** Both nodes
carry integrator state (previous drivers; per-bone lagged Euler). The manager's
`setState` callback persists into `behaviors.config._nodeState` in SQLite, so
using it here would mean a read-modify-write of the behavior row at the pose rate
(~60Hz) for a value that is meaningless after a restart. Node instances live for
the graph's lifetime, so plain private fields are the right home.

For the same reason `PoseStylizerManager._persistNodeState` **skips
`on_pose_broadcast`** (`EPHEMERAL_STATE_KINDS`): the interceptor registry injects
the entire current pose into that node's state before every fire.

> Note: `ManualCalibrationManager` does not have this guard, so it does write a
> full pose into SQLite on every interceptor frame. Same fix applies there.

**Both value outputs memoize on the input pose object's identity.** Value outputs
are pulled on demand and could in principle be pulled more than once per frame;
memoizing on the (per-frame-fresh) `NormalizedPose` instance guarantees the lag
integrators advance exactly once per frame.

**Typing.** `StyleDrivers` is a `SignalTypeMap` entry with its own port colour, so
the drivers edge is typed rather than `Any`. Both nodes are ordinary static nodes
— decorated ports via `defaultInfer`, no `INFER_BY_KIND` entry.

`Quaternion.slerp` was added to `shared/src/signal.ts` for the `amount` blend
(shortest-arc, with a normalized-lerp fallback for nearly-parallel rotations).

---

## Known limitations

- **The behavior graph is `readonly: true`** — it cannot be rewired in the
  substrate editor. Everything user-facing goes through the behavior config.
- **`energy` cannot leave the behavior.** There is no `set_data` node in the
  template and no other bridge, so it cannot currently drive a Logic graph,
  expressions, or particles — only bones, via a rig entry. Adding a `set_data`
  publish (or a drivers→data-channel node) would be the fix; see
  [data-channels.md](data-channels.md).
- **Interceptor priority is fixed at 8.** `_persistNodeState`'s sibling
  `_getNodeConfig` does honour a `config.nodeConfig[nodeId]` override, but the
  manager reads priority from `nodeDef.defaultConfig` at graph-construction time,
  so that escape hatch does not reach it. Ordering against other interceptors
  (manual calibration at 5, breathing) is not user-configurable.
- **Driver extraction is hardcoded.** Which bone chains are read (`TORSO_CHAIN`,
  `HEAD_CHAIN`) and the arm-elevation axis live in `pose_style_drivers.ts`. The
  set of nine drivers is fixed; adding one is a code change.

## Extending

- **A new driver**: add it to `STYLE_DRIVER_NAMES` + `ZERO_DRIVERS`, populate it
  in `PoseStyleDrivers._read`, and (optionally) give bones a response for it.
  The conditioning loop, the UI driver picker, and the i18n key set all iterate
  `STYLE_DRIVER_NAMES`, so only `driver.<name>` translations need adding by hand.
- **A new response knob**: add it to `StyleResponse` + `DEFAULT_STYLE_RESPONSE`,
  then add a row to `RESPONSE_FIELDS` in `PropertiesPanel.tsx` and the matching
  `response.<key>` / `responseTip.<key>` i18n keys.
- **A new preset**: add it to `STYLE_RIG_PRESET_NAMES` + `STYLE_RIG_PRESETS`
  (ideally as a `mergeStyleRig` delta on `STYLE_RIG_FOLLOW`, so the diff is
  readable) and add `presetName.<id>` / `presetHint.<id>` i18n keys. The UI
  dropdown and the shared preset invariants both iterate the name list, so a new
  preset is automatically held to the gaze-on-target contract.
- **Retuning a stock rig**: edit `STYLE_RIG_FOLLOW` or `COUNTER_HEAD_RESPONSE`.
  The chain-total and sign-convention tests will tell you if you broke the design
  contract.

## Tests

| File | Covers |
|---|---|
| `packages/shared/test/style_rig.test.ts` | The pure data model: default-rig invariants (chain totals, counter-rotation, lag stagger, mirroring, modes), `mergeStyleRig` merge/prune/drop semantics, `evaluateBoneResponse`, `resolveStyleResponse`. |
| `packages/backend/test/nodes.stylize.test.ts` | Both nodes through the real engine: driver extraction and normalization, clamp / deadzone / rate-limit / smoothing behaviour over fake-timer frames, rig fan-out, replace vs add, amount blending, `restUnmapped`, per-bone lag ordering and convergence, and the two nodes wired together. |
| `packages/backend/test/managers.test.ts` | `PoseStylizerManager` lifecycle, interceptor register/unregister, hot-applied config, and an end-to-end pass through the interceptor chain. |
| `packages/backend/test/managers.persist.test.ts` | The `_nodeState` persist path *and* the ephemeral-kind skip. |
| `e2e/tests/editor-behaviors-effects.spec.ts` | Adding the behavior in the editor and round-tripping every panel control through REST. |
