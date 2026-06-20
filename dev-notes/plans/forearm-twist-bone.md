# Plan: Synthesized forearm twist bones

> Branch: `claude/mediapipe-vmc-tracking-align-bfbdak` · Status: implemented (core; sleeve-exclusion heuristic still deferred). Module doc: [../modules/twist-bones.md](../modules/twist-bones.md).

## Goal

Make forearm pronation/supination twist read smoothly *along* the forearm instead
of pinching at the elbow. The VRM standard humanoid has only one `lowerArm` bone, so
any roll applied to it lands at the elbow. Drive the model's own forearm twist bone
when it has one; otherwise synthesize one (insert + re-skin) on demand. The pose
pipeline must work identically with or without a twist bone.

## Constraints

- **Additive & gated.** The no-twist-bone path must stay exactly as it is today
  (backend splits roll across upper arm + forearm via `ARM_ROLL_UPPER_SHARE`). The
  twist-bone path is a frontend post-step layered on top — zero regression when off.
- Backend stays the source of orientations; twist *distribution* is a rig concern and
  lives in the frontend (it's the side that knows the skeleton).
- Pose is applied via `vrm.humanoid.setNormalizedPose()` + `update()` in
  `Viewport.tsx`. A synthesized twist bone is a **raw, non-humanoid** bone, so it is
  driven in raw space *after* that call (three-vrm leaves non-humanoid bones alone).
- Mesh surgery must be reversible/neutral: at rest the twist bone is identity, so the
  model looks unchanged until pronation occurs.
- Frontend i18n (en/de) + a HelpButton are part of "done" for the new prop.

## Files in scope

- `packages/frontend/src/components/editor/twistBones.ts` (new) — detect / synthesize /
  re-skin / per-frame drive. Exposes a per-avatar registry.
- `packages/frontend/src/components/editor/Viewport.tsx` — call setup on VRM load; call
  the per-frame drive after `setNormalizedPose`+`update`.
- `packages/frontend/src/components/editor/PropertiesPanel.tsx` — "Force twist bone"
  toggle on the avatar node, + HelpButton.
- `packages/frontend/src/i18n/locales/{en,de}/*.json` — toggle label/help strings.
- `packages/frontend/src/help/content/{en,de}/*.md` — help section.
- (maybe) `packages/backend/.../pose_arms_to_bones.ts` — default `ARM_ROLL_UPPER_SHARE`
  to 0 when desired so all the roll reaches the forearm for the twist bone to spread.

## Out of scope (deferred)

- **Sleeve exclusion heuristic** — keeping the twist bone weights off sleeve/cuff
  geometry that shouldn't spiral. Separate follow-up; discuss after the core lands.
- Twist bones for anything other than the forearms (e.g. upper-arm twist, thigh twist).

## Approach

### Detection
- On VRM load, for each side, look for an existing twist bone: a child of `lowerArm`
  on the path to `hand` whose name matches `/twist|roll/i` (covers common rigs:
  `J_Bip_L_LowerArmTwist`, `LeftForeArmTwist`, …). Record it if found.

### Synthesis (when none found AND `forceTwistBone` is on)
1. Create a `THREE.Bone`, parent it to raw `lowerArm`, position it partway toward the
   wrist (≈60% of lowerArm→hand).
2. For every forearm `SkinnedMesh`, append the bone to `skeleton.bones` +
   `skeleton.boneInverses` (boneInverse = inverse of its bind world matrix).
3. Re-skin: for vertices influenced by `lowerArm`, compute `t` = normalized projection
   of the vertex onto the elbow→wrist axis (bind pose). Move `t·weight` from the
   `lowerArm` influence slot onto the twist bone (use a free slot of the 4, else evict
   the smallest). Update `skinIndex`/`skinWeight`, set `needsUpdate`.
4. Reparent `hand` under the twist bone so the hand inherits the full twist.

### Per-frame drive (both detected and synthesized)
After `setNormalizedPose` + `update`, for each forearm with a twist bone:
- Decompose the `lowerArm` raw local rotation into swing + twist about the
  forearm axis (the hand bone's rest direction in lowerArm-local space).
- Set `lowerArm` = swing (de-rolled); set twist bone local = the twist. With the hand
  reparented under the twist bone, the hand's world orientation is unchanged, but the
  forearm vertices now follow the twist-bone gradient → smooth twist.
- A `twistGradient` factor (0..1) controls how much of the roll the bone takes (the
  rest stays on `lowerArm`), to tune the elbow→wrist falloff.

### No twist bone
Nothing runs; the backend's upper-arm/forearm split stands.

## Acceptance / verification

- `pnpm lint` passes (both packages).
- Toggle off / no twist bone: arms identical to current behaviour.
- Detected twist bone: pronation spreads along the forearm, no elbow pinch; hand
  orientation unchanged; rest pose visually identical.
- Synthesized twist bone: same, on a model that lacked one. No mesh explosion, no
  NaNs, weights sum to ~1 per vertex.

## Output

Commit per stage on the working branch. (No PR unless asked.)
