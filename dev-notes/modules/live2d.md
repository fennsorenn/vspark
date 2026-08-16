# Live2D 2D avatars

Live2D Cubism avatars as a first-class scene entity, driven by the **same**
per-node tracking data that drives VRM `avatar` nodes (MediaPipe face, mic
lipsync, VMC/ARKit blendshapes, head pose) — no signal-graph changes, because
the per-node blendshape/pose broadcast bus already routes to a node's id.

> **Status: WIP — merged deliberately unfinished.** A model uploads, loads and
> **renders in the viewport**, and it **does respond to tracking** — both
> confirmed in-browser with the official Hiyori sample. The gap is quality, not
> wiring: the blendshape / head-pose → `Param*` mapping in
> `lib/live2dParamMap.ts` is **sparse**, so the puppet moves but does not yet
> look good. Widening and tuning that mapping is the next work.
>
> Merged at 0.x on the "land it, then iterate" principle — the alternative was a
> branch drifting further behind `dev` (it was 105 commits behind at merge, and
> reconciling that surfaced three separate bugs). Rendering-tuning spots remain
> flagged `// VERIFY` in `Live2DRuntime.ts` (MVP/projection fit,
> `flipY`/premultiplied-alpha, the `setRenderState` framebuffer target); they are
> no longer *unverified*, but they have only been eyeballed on one model.

### Known gaps (as merged)

- **The param mapping is sparse.** Tracking reaches the puppet and moves it, but
  the result reads as under-driven — too few `Param*` targets covered, and the
  ones that are covered are untuned. This is the main thing standing between
  "works" and "usable". Start from `lib/live2dParamMap.ts` (it is a pure module,
  so it is cheap to iterate on) and the per-node override editor in the
  properties panel, which lets a user compensate without a code change.
- ~~**Bundle uploads fail silently on a malformed model.**~~ **Fixed** — the
  manifest is now parsed at ingestion and its `FileReferences` resolved against
  the arriving file set. See *Bundle completeness* below.
- **Dropping a model folder onto the asset dock does not work.** Drag-and-drop
  routes each file through the single-file upload endpoint, flattening the bundle
  into separate unusable assets. Only the Models-tab **Upload Live2D** button
  (folder picker) takes the bundle path. Zip ingestion and an incremental
  "missing files" flow are planned (see
  `dev-notes/plans/live2d-bundle-ingestion.md`) and unbuilt — today a bundle
  reported as incomplete must be re-uploaded whole, not topped up.
- **A lone `.model3.json` uploads successfully** via the single-file endpoint and
  produces an asset classified as `live2d` that can never load.

## Key decisions

- **Renderer:** the official **Live2D Cubism Web Framework** + Cubism Core — not
  `pixi-live2d-display`. No PixiJS; we own the GL loop and the parameter API.
- **Surface:** a real **`live2d` scene-node kind** (not a compose layer), so it
  gets a `nodeId` and inherits the tracking bus, components, transforms,
  opacity, and track clips for free.
- **Distribution / licensing:** the proprietary **Cubism Core is never bundled**.
  Integration code stays in-tree and MIT-clean; `live2dcubismcore.min.js` is
  lazy-fetched from the CDN at runtime, on a persisted user opt-in. This keeps
  published artifacts free of redistributed proprietary code.
- **Open seam:** everything is written against a small **`Puppet2DRuntime`**
  interface; `Live2DRuntime` is the first and only adapter. Inochi2D is a
  possible future second adapter — not built, but not precluded.

## Map of the parts

### Frontend — `packages/frontend/src/lib/puppet2d/`
- `types.ts` — the `Puppet2DRuntime` interface: `load(bundleUrl)`, `listParams()`,
  `setParam(id, value)`, `update(dt)`, `renderToTexture(): THREE.Texture`,
  `dispose()`.
- `live2d/coreLoader.ts` — injects the Cubism Core `<script>` once
  (`ensureCubismCore`), idempotent. Owns the **consent gate**: `hasLive2dConsent`
  / `setLive2dConsent` (interim `localStorage` mirror of
  `AppConfig.live2dLicenseAccepted`); `ensureCubismCore` rejects without consent
  so the Core is never fetched silently.
- `live2d/Live2DRuntime.ts` — the adapter. Loads the Core, then **dynamic-imports**
  the framework (after the Core global exists — some framework modules read
  `Live2DCubismCore` enums at eval time), parses `*.model3.json` via
  `CubismModelSettingJson`, loads the `.moc3` + textures, creates a
  `CubismRenderer_WebGL`, and renders into an **off-screen WebGL canvas** exposed
  as a `THREE.CanvasTexture`. `setParam` resolves string ids through the
  framework's id manager (cached).

### Frontend — mapping & node
- `lib/live2dParamMap.ts` — pure, stateless translation from a blendshape record
  + neck quaternion into `Param*` assignments. `DEFAULT_BLENDSHAPE_MAP` covers
  eyes/mouth/brows; head angles come from `quatToEulerXYZ` (ported verbatim from
  the backend's `pose_torso_head_to_bones.ts` so the two agree). Per-node
  overrides merge over the default.
- `components/editor/Viewport.tsx` → `Live2DNode` — mounts the runtime on
  `modelUrl` change, drives `mapToLive2dParams` from the node's
  `getVmcBlendshapes`/`getVmcPose` feed each frame, and renders the texture on a
  plane (screen/world facing). **Any load/runtime error falls back to the
  editor-only placeholder** — a failure never blanks the app.
- `components/editor/PropertiesPanel.tsx` → `Live2DProperties` — model select
  (from uploaded `live2d` assets), transform/facing/auto-blink-breath, the
  **license-acceptance** block (writes `AppConfig` + consent gate), and the
  **parameter-override editor** (source field, gain, invert) populated from the
  model's discovered params (`live2dParamsByNode`).
- `components/editor/AssetManager.tsx` — the **Models tab** lists `live2d`
  alongside `model` assets, with an **Upload Live2D** folder picker
  (`webkitdirectory` → `/assets/bundle`), an **Add to Scene** action
  (`createNodeFromLive2dAsset`), and **Apply to &lt;node&gt;** for a selected
  `live2d` node. Dragging a `live2d` asset onto the scene tree/viewport also
  creates a node (`dnd.ts`).

### Build integration (the non-obvious bit)
The framework is a **git submodule** at
`packages/frontend/vendor/CubismWebFramework`. Its source is authored for a
looser tsconfig and references the proprietary Core's globals, so it must not be
type-checked by this repo's strict tsc. The boundary:
- `src/types/cubism-framework.d.ts` — hand-written **ambient `declare module`s**
  for the `@cubism/framework/*` paths we import (signatures verified against the
  submodule). With no tsconfig `paths` entry, tsc resolves imports to *these*,
  never the real source.
- `vite.config.ts` — a `resolve.alias` maps `@cubism/framework/*` to the real
  submodule `src`, so Vite/esbuild **bundles the actual code** (verified: it
  code-splits into `live2dcubismframework`, `cubismusermodel`, … chunks, kept out
  of the main bundle and only fetched when a Live2D node mounts).
- **CI** must check out submodules (`actions/checkout` with `submodules:
  recursive`) or `vite build` can't resolve the alias. *(Not yet applied to
  `.github/workflows/ci.yml` — the session token lacked `workflow` scope; apply
  manually.)*
- Fresh clones need `git submodule update --init --recursive`.

### Backend
- `routes/assets.ts` — `POST /projects/:id/assets/bundle` accepts a multi-file
  bundle (kind `live2d`), validates relPaths (no traversal, via `isSafeRelPath`
  in `routes/shared.ts`), requires exactly one `*.model3.json`, runs the
  completeness check below, allocates a non-colliding dir under `live2d/`, and
  registers the manifest as an `asset_files` row.
- `routes/config.ts` — `PUT /config` accepts partial updates including
  `live2dLicenseAccepted` (persisted to `config.json`).

## Bundle completeness

A `*.model3.json` names every other file in the bundle **by a path relative to
itself**. Nothing used to check that those paths resolved, so a flattened or
truncated download was accepted, stored, registered — and then rendered as a
blank placeholder with no explanation. (The concrete case: a `hiyori-main`
download whose manifest wanted `hiyori_free_t08.2048/texture_00.png` and
`motion/*.motion3.json` while every file sat at the root.)

**`packages/shared/src/live2d.ts`** (`@vspark/shared/live2d`) is the whole rule,
pure and dependency-free so it runs on the route and in the browser alike:

- `parseLive2dManifest(manifestRelPath, text)` → every `FileReferences` entry as
  a `Live2dFileRef { ref, relPath, kind, required, label? }`, resolved against
  the manifest's own directory and deduplicated. Kinds: `moc`, `texture`,
  `physics`, `pose`, `displayInfo`, `expression`, `motion`, `motionSound`,
  `userData`. **`Groups`, `HitAreas` and `Layout` are not file references** and
  are deliberately not walked (verified against the submodule's
  `cubismmodelsettingjson.ts`, 5-r.3).
- `normalizeBundlePath(p)` — collapses `.`/`//`, resolves `..`, and returns
  `null` for anything absolute, backslashed, NUL-bearing or escaping the bundle.
  Stricter sibling `isSafeRelPath` (`routes/shared.ts`) guards the write path;
  everything it accepts this returns unchanged, so a file written to disk always
  matches the path the check compared against.
- `checkLive2dBundle(...)` → `Live2dBundleReport` splitting misses into
  **`missingRequired`** (`Moc`, `Textures` — nothing renders without them) and
  **`missingOptional`** (everything else — the model still renders).
- `isLive2dBundleBlocked(report)` — required-missing *or* a manifest-level error.

Route behaviour: blocked → `400 LIVE2D_BUNDLE_INCOMPLETE` with the report as
`error.details`, **written before any file touches disk**, so there are no orphan
directories and no half-registered asset. Not blocked → `201` with
`data.missingOptional` attached. Several manifests in one upload →
`400 LIVE2D_MULTIPLE_MANIFESTS` rather than silently picking the first.

Matching is **exact and case-sensitive**. Inferring that a root-level
`texture_00.png` satisfies a `foo.2048/texture_00.png` reference is tempting —
it is what a human did by hand for `hiyori-main` — but guessing at a layout
yields a model that loads *wrong*, which is harder to notice and harder to debug
than one that refuses to load. Report; let the user supply.

Frontend: `api.uploadLive2dBundle` resolves to `{ asset, missingOptional }` and
rejects with an `ApiError` carrying `details`; `api.live2dBundleReport(e)`
narrows it. `components/editor/Live2dBundleReportWindow.tsx` renders the report
(required / optional / manifest-error sections, each row showing the path the
manifest expected) and is the shell the planned incremental-completion flow
grows into. Help lives at `help/content/{en,de}/live2d.md`.

## Driving a puppet (tracking input)
A puppet consumes the **same per-node broadcast bus** as a VRM avatar — the bus
is keyed purely by `nodeId`, renderer-agnostic. Attach a tracking behavior to the
`live2d` node and `Live2DNode` maps its output. The puppet-scoped option is
**`vmc_receiver_2d`** ("VMC Receiver (2D)", `applicableTo: ['live2d']`): the same
`VmcManager`, UDP socket pool, and OSC ingest as the 3D `vmc_receiver`, but a
trimmed graph (`makeVmcGraphDescriptor2d`) that drops the skeleton-dependent
arm-IK stage and wires head/spine calibration straight to the pose broadcast — so
no VRM skeleton is loaded and no arm-IK runs. Routing is two
`kind IN ('vmc_receiver','vmc_receiver_2d')` queries (`index.ts`, `routes/shared.ts`);
the manager branches the template on the behavior's kind. The Properties UI
(`VmcReceiverProps`/`CalibrationSection`) reuses the 3D editor but hides the arm
calibration for the 2D kind. (The generic `vmc_receiver`, being `['any']`, can
also be attached and works — its arm-IK simply passes through with no skeleton —
but `vmc_receiver_2d` is the clean, purpose-named choice.)

**Blendshape naming gotcha:** with the default VMC config only the `fcl` mapper
is enabled, so the bus carries **VRoid `Fcl_*` names** (e.g. `jawOpen`→`Fcl_MTH_A`,
`browInnerUp`→`Fcl_BRW_Surprised`), *not* raw ARKit names. `DEFAULT_BLENDSHAPE_MAP`
therefore reads both schemes via `source`/`source2` + `combine:'max'` so it works
whether `fcl` or `passthrough` (raw ARKit) is enabled.

**Crispness:** the Cubism renderer's clipping-mask buffer defaults to 256², which
makes masked drawables look downscaled-then-upscaled; `Live2DRuntime` calls
`setClippingMaskBufferSize(canvas.width)` and renders at 2048² with mipmaps off.
Also note `CubismUserModel.createRenderer(maskBufferCount)` takes only the mask
buffer *count* — it ignores width/height.

## Data flow (one frame)
1. A tracking behavior on the node writes blendshapes + a `neck` quaternion into
   the per-node broadcast bus (same path as VRM).
2. `Live2DNode`'s `useFrame` reads them, calls `mapToLive2dParams(...)` (default
   map ∪ node overrides), and `setParam`s each result.
3. `runtime.update(dt)` advances the Cubism model and redraws the off-screen
   canvas; `texture.needsUpdate = true` pushes it to the plane.

## Extending
- **New source → param mapping:** add an entry to `DEFAULT_BLENDSHAPE_MAP`, or
  use the per-node override editor. Head-angle shaping lives in `HeadAngleConfig`.
- **A second 2D runtime (e.g. Inochi2D):** implement `Puppet2DRuntime` and select
  it in `Live2DNode` by bundle format. The node, mapping layer, upload path, and
  properties UI are runtime-agnostic.
- **Auto-blink / breath / idle motion:** not yet wired; the framework's effect
  classes (`CubismEyeBlink`, `CubismBreath`, motion) are available through the
  `CubismUserModel` base for a follow-up.

## Cross-references
- [scene-graph.md](scene-graph.md) — flat-mounted scene-node kinds (`live2d`
  mounts like `billboard`/`video`).
- [mediapipe-tracker.md](mediapipe-tracker.md), [lipsync.md](lipsync.md) — the
  components that feed the bus this node consumes.
- [asset-management.md](asset-management.md) — asset kinds + the bundle endpoint.
- `dev-notes/plans/live2d-integration.md` — the originating plan (decisions,
  licensing rationale, roadmap).
