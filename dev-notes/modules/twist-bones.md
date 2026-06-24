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

`setupForearmTwist(nodeId, vrm, { force, excludeSleeves?, gradient? })` runs on
VRM load and whenever the `forceTwistBone` (or `excludeSleeves`) property changes
(`useEffect` in `AvatarNode`, keyed on `vrmLoaded`, `forceTwistBone`, `node.id`).
It tears down first, then per side (`left`/`right`):

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

## Sleeve exclusion (synthesized only, `excludeSleeves` on)

Synthesized twist weight ramps every `lowerArm`-weighted vertex, which makes a
loose sleeve/cuff spiral like skin. When `excludeSleeves` is on,
`reskinForearm` runs a one-time post-pass (`excludeSleevesForMesh`) **after**
the re-skin, once per forearm `SkinnedMesh`, that keeps twist weight only on
geometry physically continuous with the hand and rolls it back everywhere else:

1. **Weld** vertices into nodes by quantized position (`SLEEVE_WELD_EPS = 1e-5`)
   so UV/material seams that split a shared position into multiple vertices
   don't break connectivity.
2. **Edge adjacency** over welded nodes, built from the index buffer (each
   triangle links its three node corners).
3. **Seeds** = welded nodes carrying a hand- or finger-bone influence above
   `SLEEVE_SEED_WEIGHT = 0.5` (solid skin, not a partial cuff). The seed bones
   are the hand bone's subtree — `side.hand.traverse(...)` — which, since the
   hand is reparented under the twist bone, is exactly hand + fingers.
4. **BFS** from the seeds, stepping into a node **only if it carries twist
   weight**; every reached twist-weighted node is `keep`.
5. **Roll back** twist weight on every twist-weighted vertex *not* kept: its
   `twist` slot weight is moved back onto `lowerArm` (`setWeightForIndex(...,
   twistIndex, 0)` + `addWeight(..., lowerIndex, w)`).

**Safety guard** (`SLEEVE_KEEP_GUARD = 0.1`): a mesh that *has* skin seeds but
keeps `< 10%` of its twist nodes is treated as a connectivity artifact (e.g. the
body skin under the sleeve was deleted, leaving the seeds disconnected) and is
left untouched rather than de-twisted. A mesh with **no** seeds at all (a
separate sleeve mesh) skips the guard and correctly excludes everything.

The pass only edits `skinIndex`/`skinWeight`, so it's reversible via the same
per-mesh teardown snapshot. **Known limitation:** a cuff weighted `> 0.5` to the
hand can still seed (and thus keep twist on) a sleeve, and a *fitted* sleeve that
should twist with the arm is excluded — toggle `excludeSleeves` off to keep it.

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

## Avatar node properties — `forceTwistBone` / `excludeSleeves`

Two booleans on the VRM avatar node's `properties` bag (the
`scene_nodes.properties` JSON column):

- **`forceTwistBone`** — when on, a forearm twist bone is synthesized for models
  that lack one; models with their own twist bones are driven regardless of this
  flag.
- **`excludeSleeves`** — when on (and only meaningful when synthesizing), runs
  the sleeve-exclusion pass above so loose sleeves/cuffs bend with the arm
  instead of spiralling. Passed through as `setupForearmTwist(..., {
  excludeSleeves })` → `reskinForearm`.

Both are wired identically:

- Shared type: `SceneNodeProperties.forceTwistBone` / `.excludeSleeves` in
  [`packages/shared/src/types.ts`](../../packages/shared/src/types.ts); Zod in
  [`packages/shared/src/schema.ts`](../../packages/shared/src/schema.ts).
- Mirrored on the store `NodeProperties`
  ([`store/editorStore.ts`](../../packages/frontend/src/store/editorStore.ts))
  and the api-client `NodeProperties`
  ([`api/client.ts`](../../packages/frontend/src/api/client.ts)).
- UI: a **Force twist bone** toggle on the avatar section of `PropertiesPanel.tsx`
  with a nested **Exclude sleeves** checkbox shown only while `forceTwistBone` is
  on, + a `HelpButton topic="avatar" anchor="twist"`.
- i18n: `avatar.twistHeader` / `avatar.twistForce` / `avatar.twistExcludeSleeves`
  / `help.twist` in `i18n/locales/{en,de}/properties.json`; help section
  `{#twist}` in `help/content/{en,de}/avatar.md`. See [i18n-help.md](i18n-help.md).

## Test fixtures

Three VRoid sample avatars (VRM 0.x, **no** twist bones) are vendored at
`packages/frontend/public/samples/AvatarSample_{A,B,C}.vrm` to exercise the
synthesis path.

## Deferred / planned

- **Sleeve exclusion** — implemented behind the `excludeSleeves` toggle (see
  "Sleeve exclusion" above). Remaining limitation: a fitted sleeve that should
  twist is excluded, and a cuff weighted `> 0.5` to the hand can still seed.
- Twist bones for joints other than the forearms (upper-arm, thigh).
