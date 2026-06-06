# Plan: Live2D Avatar Integration

> Branch: `claude/epic-volta-QBoUm` · Status: draft → ready-for-review
> This plan is the seed context for an implementer (cloud worker or local). It is a
> starting point, not an airtight spec — refine interactively as needed.

## Goal

Add **Live2D 2D avatars** to vspark as a first-class scene entity, driven by the same
live tracking data that already drives VRM avatars (MediaPipe face, mic lipsync, VMC/ARKit
blendshapes, head pose). A user uploads a Cubism model bundle, drops it into a scene as a
new `live2d` scene node, and it lip-syncs / blinks / turns its head from any tracking
component attached to that node — no signal-graph changes required, because the per-node
blendshape + pose broadcast bus already routes to the node's id.

## Decisions (locked with user)

1. **Renderer:** the **official Live2D Cubism Web Framework** (`CubismWebFramework` +
   `Live2DCubismCore`), *not* `pixi-live2d-display`. No PixiJS dependency. We own the GL
   render loop and the parameter API (`setParameterValueById` / `getParameterIndex`).
2. **Surface:** a new **`live2d` scene-node kind** (not a compose layer). It gets a real
   `nodeId`, so the existing per-node blendshape/pose bus, the `mediapipe_tracker` /
   `lipsync` / `vmc_receiver` components, transforms, opacity, and track clips all apply
   for free — exactly like a VRM `avatar` node.
3. **This pass is the plan only.** Implementation follows after review.

## Licensing & vendoring (READ FIRST — this is the non-obvious part)

Unlike the rest of the stack, Live2D Cubism Core is **proprietary**, not MIT.

- **Cubism Core** (`live2dcubismcore.min.js`) is required at runtime and is *redistributable*
  under Live2D's terms, but the framework source is **not on npm** — it is consumed as
  source/submodule from [`Live2D/CubismWebFramework`](https://github.com/Live2D/CubismWebFramework),
  and the Core is downloaded from the [Cubism SDK for Web](https://www.live2d.com/en/sdk/download/web/).
- **Free** for individuals and businesses under **¥10M/yr** revenue; a paid **Publication
  License** is required above that threshold
  ([SDK license](https://www.live2d.com/en/sdk/license/)). vspark ships via GitHub Releases,
  so this must be surfaced to the user (a one-line notice + link in the Live2D properties
  panel and in the README is sufficient for v1).
- **Vendoring approach (recommended):** vendor a pinned copy of the Cubism Core
  (`live2dcubismcore.min.js`) and a pre-built/copied subset of the Framework TS sources
  under `packages/frontend/src/lib/live2d/` (or `vendor/live2d/`), with their `LICENSE.md`
  kept intact alongside. Load the Core as a global (`window.Live2DCubismCore`) via a
  `<script>` injected on first Live2D node mount (lazy — don't pay the cost for VRM-only
  projects), then `Live2DCubismFramework.startUp()`. Do **not** add an npm dep that
  silently pulls the Core — keep the license file visible in-tree.
- Confirm the exact vendoring mechanics (submodule vs copied dist vs a thin npm shim like
  `live2dcubismframework`) during implementation; the design below is renderer-agnostic
  about *how* the framework is bundled, only that it exposes load + `setParameterValueById`
  + `update` + a `CubismRenderer_WebGL`.

## Constraints / patterns to preserve

- **Scene-node kinds are schema-free at the DB layer** — `scene_nodes.components` is a JSON
  blob; no migration to add `live2d`. Add the kind to `sceneNodeKindSchema`
  (`packages/shared/src/schema.ts:28`) and the `NodeKind` union (`packages/shared/src/types.ts`).
- **Blendshapes already route by `nodeId`.** `getVmcBlendshapes(nodeId)`
  (`packages/frontend/src/vmcPoseStore.ts:35`) returns the summed/clamped
  `Record<string, number>` the broadcast bus produced for that node; `getVmcPose(nodeId)`
  (`vmcPoseStore.ts:22`) returns bone quaternions including `neck`. The Live2D node reads
  the **same** two functions a VRM avatar does — zero backend change.
- **The flat-mount-to-texture pattern already exists.** `FeedCanvasNode`
  (`Viewport.tsx:3717`) and `TextCanvasNode` (`Viewport.tsx:3538`) render off-screen content
  into a `THREE.CanvasTexture` on a plane and are flat-mounted top-level for pool/cache
  stability. The Live2D node follows the same shape, except the texture source is a **live
  WebGL canvas the Cubism renderer draws to**, refreshed each `useFrame`, rather than an
  `html2canvas` snapshot.
- **Transform/opacity/clips** flow through `useTransformWithOverride(node)` +
  `useApplyOpacity(ref, opacity)` (see `BillboardNode`/`VideoNode` for the reference call
  sequence). Use them so clips/overrides animate the Live2D plane for free.
- **Node creation** goes through `createKinds.ts` (`NODE_KIND_DEFS` +
  `createSceneNode` default-component bag) so the SceneGraph, ComposeTree, and the
  AssetManager "Create" palette all add it identically.
- Type-check (`pnpm lint`) is the only correctness gate. No test runner.

## Asset model — multi-file Live2D bundles

A Cubism model is a **bundle**, not a single file:
`foo.model3.json` (manifest) + `foo.moc3` (binary rig) + `textures/*.png` +
`foo.physics3.json` + optional `*.motion3.json`, `*.exp3.json`, `*.cdi3.json`. The manifest
references siblings by **relative path**, so they must live in one directory served
statically with that structure intact.

The current asset pipeline is **single-file**: upload is one base64 blob filed by extension
into a flat subfolder (`routes/assets.ts:56`), served from
`/uploads/<projectId>/<subfolder>/<file>` (`index.ts:57` `express.static`). `discoverAssets`
(`routes/shared.ts:211`) already walks per-subfolder files but assumes a flat layout.

**Plan — add a bundle upload path that preserves directory structure:**

1. **Backend — new endpoint** `POST /api/projects/:projectId/assets/bundle` in
   `routes/assets.ts`. Accept a **zip** (base64) whose root contains a `*.model3.json`.
   Extract into `uploads/<projectId>/live2d/<sanitized-model-name>/…` preserving subpaths
   (use a zip lib — note: there is no zip dep yet; `update.ts:191` references a
   `vspark-*.zip` but extraction there is handled by the external start script, so a new
   dependency is needed. Prefer a tiny, well-audited extractor; reject path-traversal
   entries `..`/absolute). Register **one** `asset_files` row representing the bundle: its
   `stored_path` points at the `*.model3.json`, `mime_type = 'application/x-live2d-model'`.
   Do **not** register every sibling as its own asset row.
   - Alternative if a zip dep is unwanted: accept a multi-file JSON payload
     `{ rootName, files: [{ relPath, data(base64) }] }` and write each preserving `relPath`.
     The frontend already encodes uploads as base64, so this stays consistent with the
     existing upload shape and avoids a new server dep. **Recommend this multi-file-JSON
     variant** unless a zip lib is already desired elsewhere.
2. **`discoverAssets` (`routes/shared.ts:211`)** — teach it that under `live2d/` each
   immediate subdirectory is one bundle: register the contained `*.model3.json` (not every
   loose file). Skip re-registering bundle siblings.
3. **MIME/subfolder maps (`routes/shared.ts:116`/`141`)** — add `.model3.json →
   'application/x-live2d-model'` recognition for the manifest (other bundle files keep their
   natural MIME; they're served raw and only fetched relative to the manifest, never listed).
4. **Static serving needs no change** — `express.static('/uploads')` already serves nested
   paths, so the Cubism loader's relative fetches (`./foo.moc3`, `./textures/00.png`)
   resolve against `/uploads/<proj>/live2d/<model>/` for free.

**Frontend asset classification — `packages/frontend/src/api/client.ts`:**

- `AssetFile.kind` union: add `'live2d'`.
- `guessAssetKind(name)`: `.model3.json` (and the `application/x-live2d-model` MIME) →
  `'live2d'`.
- New uploader helper that takes a dropped folder / multi-file selection (or a `.zip`),
  packages it per the chosen endpoint shape, and posts it. The AssetManager drop zone
  accepts a directory (`webkitdirectory`) or a zip for Live2D.

## Frontend — `live2d` scene node

### `createKinds.ts`

- `NODE_KIND_DEFS`: `{ label: 'Live2D Avatar', kind: 'live2d', icon: '🎭' }`.
- `createSceneNode` default bag:
  ```ts
  components.live2d = {
    type: 'live2d',
    modelUrl: null,          // → the *.model3.json stored_path
    scale: 1,                // model unit → world scale
    width: 2, height: 2,     // plane size the model renders into (texture target)
    anchorY: 'center',       // pivot
    facing: 'screen',        // billboard parity (screen-locked vs world-placed)
    // motion/idle:
    idleMotion: null,        // optional *.motion3.json to loop when no override
    autoBlink: true,         // framework eye-blink effect when tracking absent
    autoBreath: true,        // framework breath effect
    // param mapping (see below); empty = use built-in default map:
    paramMap: {},            // Record<live2dParamId, { source: string; gain?; bias?; clamp? }>
  };
  ```
- `createNodeFromLive2dAsset(asset, sceneId, parentId)` — parallels
  `createNodeFromModelAsset` (`createKinds.ts:229`): make a `live2d` node with
  `components.live2d.modelUrl = asset.url`.

### `Viewport.tsx` — `Live2DNode` component + flat-mount + `renderNodeElement` case

Follow `FeedCanvasNode` (`Viewport.tsx:3717`) for the texture plumbing and `BillboardNode`
for transform/facing:

- On mount (and when `modelUrl` changes): lazy-load the Cubism Core script + `startUp()`
  once (module-level guard), then load the bundle:
  - fetch `*.model3.json`, parse it (`CubismModelSettingJson`), load the `.moc3` buffer,
    create the `CubismUserModel`/`CubismModel`, load textures, physics
    (`*.physics3.json`), pose, expressions, and the idle motion if configured. Build a GL
    context on an **off-screen `<canvas>`** sized to a power-of-two-ish texture (e.g.
    512×1024 for a typical portrait model; expose as config later). Attach
    `CubismRenderer_WebGL` to that GL context.
  - Wrap the off-screen canvas in a `THREE.CanvasTexture` (`textureRef`), `flipY` as the
    framework expects, mount on a plane material (transparent, premultiplied alpha) sized
    by `width`/`height`, facing per `facing` (reuse billboard facing/backface logic).
- Per `useFrame(delta)`:
  1. Read `getVmcBlendshapes(node.id)` and `getVmcPose(node.id)` (the `neck` quaternion).
  2. Run the **param-mapping layer** (below) → a list of `(live2dParamId, value)`.
  3. Apply: for each, `model.getParameterIndex(id)` →
     `model.setParameterValueById(id, value)` (or add-with-weight where appropriate). When
     no fresh tracking value exists for a param, let the framework effects (auto-blink /
     breath) fill in — gate via `autoBlink`/`autoBreath`.
  4. Advance idle motion + physics + `model.update()`; draw with the renderer into the
     off-screen GL canvas; set `texture.needsUpdate = true`.
- Apply `useTransformWithOverride(node)` to the group and `useApplyOpacity(ref, opacity)`
  (drive the plane material opacity). Add a `renderNodeElement` dispatch case for
  `kind === 'live2d'` and include `live2d` in the **flat-mount** list (the top-level
  `flatBillboard`/`flatVideo`-style filter) so the model + its GL context survive reparents
  without remount.
- Editor gizmo: when `!viewerMode`, draw the plane bounds outline (like billboard) so an
  un-loaded / loading model is still selectable.

### `PropertiesPanel.tsx` — `Live2DProps` block

- `getLive2dProps` / `saveLive2d` mirroring the video/audio blocks.
- Controls: model picker (filtered to `kind === 'live2d'` assets), scale, plane
  width/height, facing, idle-motion picker (`*.motion3.json` within the bundle — list them
  from the manifest), `autoBlink`/`autoBreath` toggles.
- **Parameter mapping editor** — a table: left = Live2D parameter id (populate from the
  loaded model's parameter list via `model` introspection, surfaced through the store like
  `vrmExpressionsForNode`), right = source field + gain/bias/clamp. A "Reset to defaults"
  button restores the built-in map. Persist on `components.live2d.paramMap` (or
  `node.properties.live2dParamMap` to match the `defaultExpressions` precedent — pick one;
  **recommend `components.live2d.paramMap`** since it's intrinsic to the node, not a UI
  override).

### `SceneGraph.tsx`

- `KIND_ICONS.live2d = '🎭'`.

### Store — `editorStore.ts`

- `live2dParamsForNode: Record<nodeId, string[]>` (the loaded model's parameter ids), set
  on model load — mirrors `vrmExpressionsForNode` so the properties panel can populate the
  mapping table. Imperative; cleared on node removal.

## The parameter-mapping layer (the real glue)

A small pure module, e.g. `packages/frontend/src/lib/live2dParamMap.ts`:

```ts
// Input: the per-node blendshape record + the neck quaternion. Output: Live2D param values.
export function mapToLive2dParams(
  bs: Record<string, number> | undefined,
  neckQuat: [number, number, number, number] | undefined,
  userMap: Live2dParamMap,           // overrides/extends DEFAULT_MAP
): Array<[paramId: string, value: number]>
```

- **Head angles** — decompose `neck` quaternion to XYZ Euler (port the `quatToEulerXYZ`
  math from `pose_torso_head_to_bones.ts:168`), convert radians → Live2D's degree-ish range
  (`ParamAngleX` ≈ ±30 pitch, `ParamAngleY` ≈ ±30 yaw, `ParamAngleZ` ≈ ±30 roll), apply
  per-axis gain. Optionally also drive `ParamBodyAngleX/Y/Z` from `chest`/`spine` at reduced
  gain.
- **Default source → param map** (overridable via `paramMap`), drawing on the names the
  system already emits (`face_landmarks_to_blendshapes.ts`, `MicCapture.ts`,
  `arkit_tables.ts`):

  | Live2D param | Source field(s) | Note |
  |---|---|---|
  | `ParamAngleX` | neck Euler X (pitch) | radians→deg × gain |
  | `ParamAngleY` | neck Euler Y (yaw) | |
  | `ParamAngleZ` | neck Euler Z (roll) | |
  | `ParamEyeLOpen` | `1 - max(eyeBlinkLeft, Fcl_EYE_Close_L)` | invert: blink→open |
  | `ParamEyeROpen` | `1 - max(eyeBlinkRight, Fcl_EYE_Close_R)` | |
  | `ParamMouthOpenY` | `jawOpen` | lipsync RMS or mediapipe geometry (bus-summed) |
  | `ParamMouthForm` | `Fcl_MTH_I - Fcl_MTH_U` (or smile from `mouthSmileL/R`) | vowel width |
  | `ParamBrowLY` / `ParamBrowRY` | `browInnerUp` (− `browDownL/R`) | |
  | `ParamEyeBallX/Y` | ARKit `eyeLookIn/Out/Up/Down*` when present | optional, VMC only |
  | `ParamCheek` | `cheekPuff` / `mouthSmile*` | optional |

  Vowel mouth shapes (`Fcl_MTH_A/E/I/O/U`) collapse into `ParamMouthOpenY` +
  `ParamMouthForm`; models with explicit vowel params can be mapped 1:1 via `paramMap`.
- **Smoothing/clamp** — apply per-param EMA + `[min,max]` clamp from the map entry so noisy
  tracking doesn't jitter the rig. Blendshapes already arrive smoothed at the source, so a
  light EMA (α≈0.5) is enough.
- **Idle fallback** — when `bs` is stale/absent (no fresh tracking; reuse the freshness
  check `Viewport.tsx` already does for pose), skip driving tracked params and let the
  framework auto-blink/breath + idle motion carry the model.

## Files in scope

Backend:
- `packages/backend/src/routes/assets.ts` — bundle upload endpoint.
- `packages/backend/src/routes/shared.ts` — `discoverAssets` bundle awareness, MIME map.
- (maybe) a small zip extractor dep + `package.json` — only if the zip variant is chosen
  over multi-file-JSON.

Shared:
- `packages/shared/src/schema.ts` — add `'live2d'` to `sceneNodeKindSchema`.
- `packages/shared/src/types.ts` — `NodeKind` union (+ optional `Live2dComponent` type and
  `paramMap` typing).

Frontend:
- `packages/frontend/src/api/client.ts` — `AssetKind` `'live2d'`, `guessAssetKind`, bundle
  uploader.
- `packages/frontend/src/lib/live2d/` *(new)* — vendored Cubism Core + Framework + their
  LICENSE; a thin `Live2DModel` wrapper (load/update/setParam/render/dispose).
- `packages/frontend/src/lib/live2dParamMap.ts` *(new)* — mapping layer + `DEFAULT_MAP` +
  quat→euler.
- `packages/frontend/src/components/editor/Viewport.tsx` — `Live2DNode`, flat-mount,
  `renderNodeElement` case.
- `packages/frontend/src/components/editor/createKinds.ts` — node def + factories.
- `packages/frontend/src/components/editor/PropertiesPanel.tsx` — Live2D props + param-map
  editor + licensing notice.
- `packages/frontend/src/components/editor/SceneGraph.tsx` — icon.
- `packages/frontend/src/components/editor/AssetManager.tsx` — Live2D tab + bundle/zip drop
  + "Add as Live2D avatar" action.
- `packages/frontend/src/store/editorStore.ts` — `live2dParamsForNode`.

## Out of scope (note as future)

- **Motion/expression sequencing via track clips or signal nodes** — v1 just loops an idle
  motion + applies live tracking. Driving named motions/expressions from the graph (a
  `live2d_motion` media-control-style command) is a strong follow-up but separate.
- **Compose-layer Live2D** — a 2D-overlay variant. Once the loader + param map exist, a
  compose-layer kind that reuses the same `Live2DModel` wrapper is cheap, but it needs a
  source-picker (layers aren't pose-consuming nodes). Defer.
- **Cubism MotionSync / audio-driven mouth from the framework** — we already have mic
  lipsync feeding `jawOpen`; don't duplicate.
- **Physics tuning UI, multi-model atlasing, hit-area interaction.**
- **Sharing one GL context across many Live2D nodes** — start with one off-screen GL
  context per node; optimize only if needed.

## Acceptance / verification

- `pnpm lint` passes across all three packages.
- A Live2D bundle (`.model3.json` + siblings) uploads, classifies as `kind: 'live2d'`, and
  its sibling files resolve (network tab shows `.moc3` / textures 200-ing from
  `/uploads/<proj>/live2d/<model>/`).
- Dropping the asset into a scene creates a `live2d` node that renders the model in the 3D
  viewport on a plane, transformable/opacity-animatable like a billboard.
- With a `mediapipe_tracker` (or `lipsync`) component attached to the node: the model's
  mouth opens with `jawOpen`, eyes blink with `eyeBlink*`, and the head turns from the
  `neck` quaternion — i.e. the **same** data a VRM avatar on that node would consume.
- The param-map editor lists the model's real parameter ids and a remap (e.g. swapping
  `ParamMouthOpenY`'s source) takes effect live.
- With no tracking attached, auto-blink/breath + idle motion play.
- License notice is visible in the Live2D properties panel.

## Output

Commit in coherent phases on `claude/epic-volta-QBoUm`:
1. Vendoring + `Live2DModel` wrapper + a hardcoded test model rendering to a texture
   (prove the renderer-in-a-texture path before any vspark wiring).
2. `live2d` scene-node kind (schema/types, createKinds, `Live2DNode`, properties, icon)
   with `modelUrl` pointed at a manually-placed bundle.
3. Asset bundle upload + classification + AssetManager Live2D tab/drop.
4. Param-mapping layer + live tracking application + param-map editor UI.
5. Idle motion / auto-blink-breath fallback + licensing notice.

Open a PR into `dev` when done (only if/when the user asks). Update `dev-notes`
(ARCHITECTURE.md status row + a new `modules/live2d.md`, cross-ref `scene-graph.md`,
`asset-management.md`, `animation.md`) via the `doc-updater` agent as phases land.
