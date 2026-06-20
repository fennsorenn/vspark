# Forearm twist bones

Frontend-only rig post-step that spreads forearm pronation/supination *along*
the forearm instead of pinching it at the elbow. The VRM standard humanoid has a
single `lowerArm` bone, so any roll applied to it lands entirely at the elbow
(the "candy-wrapper" pinch). This module drives a forearm twist bone — the
model's own, or one it synthesizes — so the roll fans out toward the wrist.

Source: [`packages/frontend/src/components/editor/twistBones.ts`](../../packages/frontend/src/components/editor/twistBones.ts).
Invoked from [`Viewport.tsx`](../../packages/frontend/src/components/editor/Viewport.tsx).

## Relationship to the backend arm-roll split

The backend `pose_arms_to_bones` node already splits the hand roll across the
upper arm and forearm via `ARM_ROLL_UPPER_SHARE` (currently `0.5`) so neither
joint shows the full twist — a coarse, bone-count-limited mitigation for the
missing twist bone. This module **layers on top** of that and is fully
**additive and gated**: when no twist bone is set up nothing runs and the
backend split stands unchanged. Backend stays the source of orientations; twist
*distribution* is a rig concern and lives in the frontend (it's the side that
knows the skeleton). See [mediapipe-tracker.md](mediapipe-tracker.md) /
`signal/nodes/pose_arms_to_bones.ts` for the split itself.

## Lifecycle

`setupForearmTwist(nodeId, vrm, { force, gradient? })` runs on VRM load and
whenever the `forceTwistBone` property changes (`useEffect` in `AvatarNode`,
keyed on `vrmLoaded`, `forceTwistBone`, `node.id`). It tears down first, then
per side (`left`/`right`):

1. **Detect** the model's own twist bone — a `Bone` descendant of `lowerArm`
   (excluding `hand`) whose name matches `/twist|roll/i` (covers e.g.
   `J_Bip_L_LowerArmTwist`, `LeftForeArmTwist`). If found, drive it directly.
2. **Synthesize** (only when none detected *and* `force` is on): insert a new
   `THREE.Bone` partway down the forearm (`SYNTH_FRACTION = 0.55`, in
   lowerArm-local space), reparent the hand under it via `Object3D.attach` (so
   the hand keeps its world transform), and **re-skin** the forearm
   `SkinnedMesh`es (see below).

`teardownForearmTwist(nodeId)` restores the original skeleton/bind/weights from
the per-mesh backup, reparents the hand back (preserving world transform, then
restoring its rest local pos/quat), and removes a *synthesized* bone (a detected
bone is left in place). `hasForearmTwist(nodeId)` reports whether any side is set
up. State lives in a module-level `registry: Map<nodeId, AvatarTwist>`.

## Re-skinning (synthesized only)

For each forearm `SkinnedMesh`, a fresh `THREE.Skeleton` is built with the twist
bone appended to `bones` + `boneInverses` (its inverse = inverse bind world
matrix), and the mesh is rebound to it. Each vertex weighted to `lowerArm` has a
fraction `t` of that weight migrated `lowerArm → twist`, where `t` is the
clamped `0..1` projection of the vertex onto the bind-pose elbow→wrist axis,
computed in lowerArm-local space via `boneInverse · bindMatrix`. Weight insertion
(`addWeight`) merges into an existing slot, takes a free one of the 4, or evicts
the smallest if the new weight is larger. The original `skinIndex`/`skinWeight`
arrays, skeleton, and bind matrix are backed up per mesh for teardown.

At rest the twist bone is identity, so splitting a vertex between two bones that
both resolve to identity changes nothing — **the rest pose is visually
identical** until pronation occurs.

## Per-frame drive

`driveForearmTwist(nodeId)` is called in `Viewport.tsx`'s `useFrame` **after**
the IK solve + `setNormalizedPose`/`update`, and **before** the spring /
constraint (motion-snappiness) updates. A synthesized twist bone is a raw,
non-humanoid bone, so three-vrm leaves it alone and it must be driven in raw
space after the humanoid pose is applied. Per side it:

- Reads the `lowerArm` local rotation `q` (the backend roll is baked in here).
- Swing-twist-decomposes `q` about the forearm axis: swing = the shortest arc
  carrying the rest axis to where `q` sends it; twist = `swing⁻¹ · q`.
- Routes a fraction of the twist (`× gradient`, default `1.0`) onto the twist
  bone and leaves the elbow swing-only: with the hand reparented under the twist
  bone, `lowerArm · twistBone = q` for any gradient, so the **hand world
  orientation is preserved** while the forearm vertices follow the twist
  gradient.

## Avatar node property — `forceTwistBone`

A boolean on the VRM avatar node's `properties` bag (the `scene_nodes.properties`
JSON column). When on, a forearm twist bone is synthesized for models that lack
one; models with their own twist bones are driven regardless of this flag.

- Shared type: `SceneNodeProperties.forceTwistBone` in
  [`packages/shared/src/types.ts`](../../packages/shared/src/types.ts); Zod in
  [`packages/shared/src/schema.ts`](../../packages/shared/src/schema.ts).
- Mirrored on the store `NodeProperties`
  ([`store/editorStore.ts`](../../packages/frontend/src/store/editorStore.ts))
  and the api-client `NodeProperties`
  ([`api/client.ts`](../../packages/frontend/src/api/client.ts)).
- UI: a **Force twist bone** toggle on the avatar section of `PropertiesPanel.tsx`
  + a `HelpButton topic="avatar" anchor="twist"`.
- i18n: `avatar.twistHeader` / `avatar.twistForce` / `help.twist` in
  `i18n/locales/{en,de}/properties.json`; help section `{#twist}` in
  `help/content/{en,de}/avatar.md`. See [i18n-help.md](i18n-help.md).

## Test fixtures

Three VRoid sample avatars (VRM 0.x, **no** twist bones) are vendored at
`packages/frontend/public/samples/AvatarSample_{A,B,C}.vrm` to exercise the
synthesis path.

## Deferred / planned

- **Sleeve exclusion heuristic** — keeping the synthesized twist-bone weights off
  sleeve/cuff geometry that shouldn't spiral with the skin. Not yet built; see
  [plans/forearm-twist-bone.md](../plans/forearm-twist-bone.md) ("Out of scope").
- Twist bones for joints other than the forearms (upper-arm, thigh).
