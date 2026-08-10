# iFacialMocap receiver

ARKit face tracking from the [iFacialMocap](https://www.ifacialmocap.com/) iOS
app, received over UDP and fed into a signal graph. It is the **face-only
sibling of the VMC receiver** and was built deliberately parallel to it — same
graph shape, same manager lifecycle, same WebSocket surface, same UI layout.
This doc covers only what is *different*; everything else is described in
[component-managers.md](component-managers.md) and [signal-graph.md](signal-graph.md).

| | |
|---|---|
| Behavior kind | `ifacialmocap_receiver` (`applicableTo: ['avatar']`) |
| Source dir | `packages/backend/src/behaviors/ifacialmocap_receiver/` |
| Graph id prefix | `ifacialmocap-pipeline:` |
| New signal node | `ifacialmocap_packet_source` (the only new node kind) |
| Default port | 49983 |
| Frontend panel | `IFacialMocapReceiverProps` in `PropertiesPanel.tsx` |
| Help | `help/content/{en,de}/behaviors.md` → `{#ifacialmocap}` |

## Wire protocol

`protocol.ts` is a pure, fully unit-tested module (`test/ifacialmocap.protocol.test.ts`)
— unlike the VMC OSC parser, which lives unexported inside its manager.

Data is **plain ASCII**, one datagram per frame, `|`-separated:

```
v2:  browDown_L&12|browDown_R&8|…|=head#rx,ry,rz,px,py,pz|rightEye#rx,ry,rz|leftEye#rx,ry,rz|
v1:  browDown_L-12|browDown_R-8|…|=head#…|rightEye#…|leftEye#…|
```

- Blendshape names are ARKit names with `_L` / `_R` side suffixes; weights are
  `0..100`. `normalizeShapeName` expands the suffix (`browDown_L` →
  `browDownLeft`) and anything not in `ARKIT_SHAPES` is dropped.
- Euler angles are **degrees**. The head's trailing three values are a
  camera-relative position in cm — parsed past, but unused (the avatar's root is
  the scene's business, not the phone's).
- `parseIFacialMocapPacket` returns `null` when a datagram carries neither a
  known shape nor a transform, so foreign traffic on a shared port is ignored
  rather than mistaken for a frame.

### Handshake (the big structural difference)

VMC is passive: bind a port and packets show up. iFacialMocap has to be **asked**.
The receiver sends

```
iFacialMocap_sahuasouryya9218sauhuiayeta91555dy3719|sendDataVersion=v2
```

to the device, and the device then streams at ~60 fps. Two consequences:

1. The behavior config carries a **`deviceHost`** (the phone's address), which
   has no VMC counterpart. It is optional — the app can also be pointed at this
   machine from the phone side, in which case the receiver just listens.
2. The handshake has to leave from the port the reply arrives on, so
   `UdpSocketPool` grew a **`send(localPort, payload, host, remotePort)`** method
   that reuses the shared bound socket. This is the only change to existing
   VMC-side code.

The manager sends the handshake on bind, then re-sends it every 1 s while the
device is silent and every 5 s while it is streaming, so an app restart
re-attaches on its own.

## Graph

`graph.ts` is the VMC pipeline with the body half removed:

```
ifacialmocap_packet_source
  ├── bones → unpack_event → rhylive_bone_mapper → body_calibration → pose_broadcast
  └── arkit → unpack_event → arkit_vrm_mapper ×3 → blendshapes_sum → blendshapes_broadcast
```

Every node except the source is shared verbatim with the VMC pipeline. Reuse of
`rhylive_bone_mapper` is what pins the manager's coordinate contract: it hands
the mapper quaternions keyed by **Unity HumanBodyBones** names (`Head`,
`LeftEye`, `RightEye`), built with Unity's `Quaternion.Euler` composition
(`q = qY · qX · qZ`) in `unityEulerToQuaternion`, and the mapper applies the
same left-handed → VRM/three flip it already applies to RhyLive data.

Differences from `vmc_receiver/graph.ts`:

- **No `arm_ik_calibration`** stage and no arm capture/reset triggers — an ARKit
  face stream has nothing below the neck. Consequently the manager also skips
  the VRM skeleton load (`loadVrmSkeleton`), which only existed to feed arm IK.
- **`HEAD_CALIB_BONES` is narrower** — `head`, `leftEye`, `rightEye` only, rather
  than the full hips→eyes chain, so a neutral capture can't store meaningless
  offsets for bones that never carry data.
- **Three axis-flip config nodes** (`cfg_invert_pitch` / `_yaw` / `_roll`) wired
  into the source node. See below.
- `cfg_device_host` replaces `cfg_host`.

## The axis-flip escape hatch

The published spec says head and eye rotations are "Euler degrees relative to
the camera" but does not pin down the handedness or axis order. We assume Unity
convention because it is what the app targets and what lets us reuse
`rhylive_bone_mapper`. **This has not been verified against a physical device.**

Rather than hard-code a guess, the receiver exposes per-axis inversion
(`invertPitch` / `invertYaw` / `invertRoll`, all default `false`) as "Head Axes"
toggles in the properties panel. They are read from the live behavior config on
every packet, so a flip hot-applies without rebuilding the graph, and the
`IFacialMocapFrame.signature` deliberately keeps the *raw* device values so
toggling one doesn't read as a motion spike.

If the Unity-convention assumption turns out to be right on real hardware, the
toggles stay at their defaults and cost nothing; if it turns out to be wrong,
users can fix it without a code change.

## Tracking detection

Structurally identical to the VMC receiver's, over a different vector, and on
the **same grace period** — see [component-managers.md](component-managers.md)
for the shared contract.

Each frame produces a fixed-length `signature` (head + both eyes' euler degrees,
then the 52 ARKit weights in canonical order). A summed absolute frame-to-frame
delta above `TRACKING_THRESHOLD` (0.01) clears `Receiver.quietSince` and
re-latches tracking; going still only *stamps* `quietSince`. Packets going away
is the second path, off `lastSeen`. The 250 ms `tick()` resolves both from
`Math.min(quietSince ?? now, lastSeen)` against
`trackingGraceMs(sceneNodeId)` — the avatar node's `trackingGracePeriod` — so
whichever dropout started first drives the window.

Why the debounce matters more here than for a body source: iFacialMocap keeps
streaming the *last* values when it loses the face, so "still" and "silent" are
genuinely different states, and a held expression is common and completely
normal. Without the window, sitting still for two frames would snap the avatar
to idle.

Reachability (the grey status dot) keeps its own fixed 3 s window, as in
`VmcManager`: whether the phone is reachable is a different question from
whether it is tracking, and the dot must not start lying because someone set a
long grace period.

## Shared surfaces (no new plumbing)

- **WebSocket**: reuses `vmc_status` and `vmc_tracking_state`, both already keyed
  by `behaviorId`. No store, message-kind or `useWsSync` change was needed; the
  SceneGraph connection/tracking dots just needed the kind added to their check.
- **Broadcast bus**: standard producer — `pose_broadcast` / `blendshapes_broadcast`
  fed a `behaviorId` from a `behavior_id` node, and `removeBehavior` on tracking
  loss / teardown.
- **Node state**: persisted into `config._nodeState[nodeId]` exactly like every
  other behavior manager.
- **Routes**: `routes/signal.ts` dispatches on the `ifacialmocap-pipeline:` graph
  id prefix for descriptors, node-states and `/fire`; `routes/shared.ts` gains
  `refreshIFacialMocap()` in `refreshAllBehaviorManagers()`.

## Frontend

`IFacialMocapReceiverProps` mirrors `VmcReceiverProps` — same blend mode, mirror
and face-mapper controls (the three `arkit_vrm_mapper` sections are the same
component with the same `nodeConfig` keys). Like the VMC panel it carries no
"Idle after" field: the grace period is a property of the avatar, edited in the
Avatar section as `trackingGracePeriod` (migration 035). Differences:

- Device IP field instead of a bind Host field.
- "Head Axes" invert toggles.
- The local-IP list is informational (which address to type into the app) rather
  than click-to-set, since the host field here is the *phone*, not this machine.
- `CalibrationSection` is shared, and gained `graphPrefix` + `arms` props so the
  face-only receiver renders head capture without the two arm rows.

See [component-managers.md](component-managers.md) for the manager pattern,
[animation.md](animation.md) for the coordinate corrections `rhylive_bone_mapper`
applies, and [i18n-help.md](i18n-help.md) for the `ifm.*` namespace keys.
