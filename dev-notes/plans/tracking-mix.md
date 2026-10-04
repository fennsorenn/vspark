# Plan: Tracking Mix — per-source, per-bone, per-blendshape tracking composition

> **Status:** in progress — implemented on `feature/tracking-mix` (2026-10-06), not yet merged into `dev`.

> Branch: `feature/tracking-mix`
> This plan is the seed context for a cloud worker. It is a starting point, not an
> airtight spec — the worker is interactive and may ask to refine it.

## Goal

When several tracking sources drive one avatar, today they are simply stacked on top of
each other. The goal is to give the user explicit control over that: how strongly
each source influences each body region and each individual bone. The same applies to
each blendshape, and the user also controls the order sources are applied in. This
replaces the current "Partial Tracking" section, which only weighs animation against
"tracking" as a whole, per region.

## Constraints

- **[decided]** Sources keep composing by **weighted multiplication**, not by a
  normalised blend. Each source contributes `slerp(I, q, w)` and the contributions
  are multiplied in order. Weights may sum to more than 1: e.g. breathing sits on top
  of full regular tracking. Weights summing to 1 approximate a blend. The result is
  exact for rotations about the same axis and order-dependent otherwise, which is
  one reason the order is user-controlled.
- **[decided]** Source **order is adjustable in the UI**.
- **[decided]** Region and bone editing: moving a region slider **sets every bone in
  that region**. Editing a single bone replaces the region slider with a
  "Custom"/"Mixed" label plus a reset button that returns to whole-region control. The
  same pattern applies to blendshape groups and individual blendshapes.
- **[decided]** Tracking sources are composed in the **backend** (the broadcast bus,
  as today). Animation stays in the **frontend** (as today). Both read one shared mix
  config on the avatar node.
- **[decided]** Blendshapes (Face) are **in scope**, using the same interface as bones.
- **[decided]** The detailed editor lives in a **modal** opened from a button in the
  sidebar. The sidebar keeps only a compact summary.
- **[decided]** Face mappings stay in the receivers. They translate a source's
  vocabulary (ARKit → model shapes), which is a per-source concern, not an influence
  control.
- **[decided]** `manual_calibration` is **not** merged into the mix. It is an angle
  correction (`angle × multiplier + offset`) on the merged pose, not a mask.
- **[observed]** `_composeBones` in `packages/backend/src/broadcast/bus.ts` sorts slots
  by `priority` and multiplies each slot's full quaternion. Slots are keyed by
  `(avatarNodeId, behaviorId)`. Receivers (vmc / ifacialmocap / mediapipe) all publish
  at priority 0 in `override` mode. Breathing publishes at priority 10 in `additive`
  mode. Position offsets are summed.
- **[observed]** `_composeBlendshapes` sums all slots and clamps to [0, 1]. Priority is
  ignored.
- **[observed]** Interceptors (pose_stylizer at 8, manual_calibration at 5,
  blendshape_limiter at 5) run on the **merged** frame after composition. They are
  unaffected by this change.
- **[observed]** The current Partial Tracking config is `properties.poseSource` on the
  avatar node: per region `{anim, track}`. Only the frontend applies it, in
  `Viewport.tsx` (`composeBonePose` → `stackBoneRotation` in `poseComposition.ts`).
  The region→bone map (`POSE_SECTION_BONES` / `BONE_TO_SECTION`) is local to
  `Viewport.tsx`.
- **[observed]** The bus already reads per-scene settings from the DB
  (`_loadSceneTickHz`, `reloadSceneSettings`). That is a precedent for reading the
  avatar node's mix config there, cached and invalidated on change.
- **[observed]** All client↔server traffic goes over the mesh (see
  `dev-notes/modules/` mesh docs). The mix config is ordinary node data and needs no
  new stream.

## Files in scope

- `packages/shared/src/types.ts`, `schema.ts` — new `TrackingMix` type and Zod schema.
  Move the region→bone grouping here (exported) so backend, Viewport and the editor
  share it.
- `packages/backend/src/broadcast/bus.ts` — weighted, ordered composition for bones
  and blendshapes; cached per-avatar mix config with invalidation.
- Backend node-update path (routes and/or mesh store write hook) — invalidate the bus
  cache when an avatar's mix config changes.
- `packages/backend/src/db/migrations/` — migrate `poseSource` → new config (see open
  questions).
- `packages/frontend/src/components/editor/Viewport.tsx`, `poseComposition.ts` — read
  the animation weights from the new config. The per-region `track` factor goes away
  (now handled per source on the backend).
- `packages/frontend/src/components/editor/PropertiesPanel.tsx` — replace the inline
  Partial Tracking block with a compact summary and an "Open mixer" button. Extract it
  into its own component file rather than growing `PropertiesPanel.tsx` further.
- New `packages/frontend/src/components/editor/TrackingMixModal.tsx` (+ subcomponents)
  — the matrix editor (follow the `OverliveAccountsModal` overlay / Escape /
  backdrop-close pattern).
- i18n `{en,de}/properties.json` (or a new namespace), help page
  `help/content/{en,de}/…` with anchors, `HelpButton`s.
- Tests (see Acceptance).

## Out of scope

- Moving manual calibration into receivers (a possible later idea: calibration often
  fixes one sender's quirks).
- Changing the face mappers / `MappingEditor`. Adding the missing mapper UI to
  `MediapipeTrackerProps` is a separate fix.
- Changing interceptor ordering or the stylizer / limiter / calibration behaviors.
- The known interceptor-priority-from-`nodeConfig` limitation
  (`modules/stylized-tracking.md`).
- Animation-layer composition itself (base / idle / one-shot clips).

## Approach

### Data model (proposal — the worker should confirm with the user)

Stored on the avatar node, flat per bone / per shape. Regions and groups are derived
in the UI only, which makes "region sets all bones" and the "Custom" state fall out
naturally:

```ts
interface TrackingMix {
  /** Behavior ids in application order (first applied first). Unlisted sources are appended by legacy priority. */
  order: string[];
  /** Key: behavior id, or the reserved key 'animation'. Missing entry / missing bone = 1. */
  sources: Record<string, {
    bones?: Partial<Record<VRMBoneName, number>>;
    blendshapes?: Record<string, number>;
  }>;
}
```

- A region slider writes the same value to every bone of the region. The UI shows the
  slider when all bones agree and "Custom" + reset otherwise.
- **[decided]** Reset sets every bone in the region to the **most frequent value** among
  its bones, falling back to **1** if no value occurs more than once. The same rule
  applies to blendshape groups and to a source's master slider. Tie between equally
  frequent values: the **higher** value wins.
- Only non-default values are persisted, matching how `poseSource` saves today.
- Stale behavior ids (deleted behaviors) are ignored on read and pruned on write.

### Backend composition

- `_composeBones`: order slots by `mix.order` (falling back to the existing
  `priority` for unlisted slots). For each bone apply `slerp(I, q, w)` with
  `w = mix.sources[behaviorId].bones[bone] ?? 1`, then multiply as today. Scale
  offsets by `w` too.
- If every source's weight for a bone is 0, **omit** the bone, so the frontend leaves
  it to the animation exactly as an untracked bone.
- `_composeBlendshapes`: `sum += w × value`, then clamp. Order doesn't matter for
  sums.
- Default weight 1 for everything reproduces today's behaviour exactly, so a project
  with no mix config is unchanged.
- The bus needs the behavior id per slot at compose time. It already has it as the
  slot key, so pass it through.

### Frontend

- Viewport: the animation weight per bone comes from `mix.sources.animation.bones`.
  The old `track` factor is removed.
- Sidebar (avatar node): a compact list of sources, each with a master weight slider
  (sets all bones and shapes for that source, showing "Custom" if they differ), plus an
  "Open mixer…" button.
- Modal: Body / Face tabs.
  - Body: rows are regions, expandable to bones. Columns are Animation plus each
    tracking source. Each cell has a slider or number input.
  - Face: rows are blendshape groups, expandable to individual shapes. Columns are the
    sources.
  - A source order control (drag or up/down). Animation is fixed as the base layer
    (proposal: not reorderable, since it is applied in the frontend underneath all
    tracking).
- Every new control gets a `vs-` handle; run `controls.mjs bless`.

### Resolved design points (user, 2026-10-05)

1. **[decided]** Existing `poseSource.track` per region is migrated (DB migration) into
   each source's bone weights for that region; `poseSource.anim` into
   `sources.animation`. `poseSource` is then dropped.
2. **[decided]** Per-cell weight range is **0..2** (allows boosting a weak source).
3. **[decided]** Face rows list the loaded model's actual expressions / morph targets
   (the frontend has the VRM; the bus doesn't know the model), grouped by name prefix
   (`Fcl_` MTH / EYE / BRW / ALL, plus VRM presets). **No Animation column** in the
   Face tab: animation clips don't drive blendshapes in vspark.
   - **[observed]** Clips are FBX retargeted onto bones only. There is no VRMA loader
     and no expression/morph track handling. Both formats *could* carry facial
     animation; supporting that is out of scope.
   - **[observed]** The avatar's `defaultExpressions` are applied first and tracked
     values overwrite them shape by shape (`Viewport.tsx` ~3497). They are not part of
     the mix.
4. **[decided]** Animation is fixed as the base layer (not reorderable). Only tracking
   sources appear in the order control.

### Still to check while implementing

- **Which behaviors count as sources:** behaviors on the avatar node that publish
  bones or blendshapes (vmc, ifacialmocap, mediapipe, breathing, api_controller
  (blendshapes only)). Check whether a behavior on another node can target this
  avatar.
- **Breathing's default position:** its current priority 10 / additive placement
  becomes its default position in `order` (applied last, on top).

## Acceptance / verification

- `pnpm lint` and `pnpm test` pass; shared coverage gate holds.
- Backend Vitest (`buildGraph` / bus unit tests):
  - no mix config gives output identical to today;
  - per-bone weights;
  - zero-weight bones are omitted;
  - order changes the result for non-commuting rotations;
  - blendshape weighting;
  - cache invalidation on config change.
- Frontend Vitest:
  - region↔bone "Custom" derivation and reset;
  - migration of `poseSource` values.
- Playwright `cov-*` spec: open the mixer, change a region, a bone and an order, then
  assert via REST read-back.
- Manual: two receivers on one avatar (e.g. VMC body + iFacialMocap face); confirm
  head weighting and face weighting behave as configured live.
- i18n en+de keys, help page + `HelpButton`s present.

## Output

Open a PR into `dev` when done.
