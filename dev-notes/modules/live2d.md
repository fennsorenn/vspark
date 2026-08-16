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
- ~~**Dropping a model folder onto the asset dock does not work.**~~ **Fixed** —
  drops descend into directories, zips are accepted, and an incomplete bundle
  can be topped up in place. See *Getting a bundle in* below.
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
narrows it. Help lives at `help/content/{en,de}/live2d.md`.

## Getting a bundle in

**`packages/frontend/src/lib/live2dBundle.ts`** turns whatever the user gave us
into `{ relPath, file }[]` with the manifest-relative paths intact. Three sources
converge on it:

- **Folder picker** — `webkitdirectory` → `File.webkitRelativePath`.
- **Dropped folder** — `readDroppedFiles()` walks `webkitGetAsEntry()`.
  `e.dataTransfer.files` does *not* descend, which is why dropping a model used
  to flatten it into unusable single assets. Note `readEntries()` returns **at
  most 100 entries per call** and must be drained in a loop; reading once
  silently truncates rather than erroring.
- **Zip** — `expandZip()` unpacks in the browser. Expansion is client-side by
  design: the endpoint keeps the one shape it already validates and untrusted
  archives never reach the server. Entry paths still go through
  `normalizeBundlePath`, and a Zip-Slip entry is **rejected, not sanitized** —
  rewriting it would hide a hostile archive. `__MACOSX/` and `.DS_Store` are
  dropped.

  It uses **`unzipSync`, not the async `unzip`**: the async variant offloads to a
  blob-URL Worker, and where that is unavailable (a CSP forbidding
  `worker-src blob:`, a non-browser host) fflate degrades to *silently wrong*
  output — every entry split into bogus directory names — rather than erroring.

`stripCommonPrefix()` removes the single top-level folder archives wrap models
in. `findManifests()` + `selectBundle()` handle a source holding several models:
`Live2dManifestPicker` asks which, and only that model's subtree is uploaded.

**Testing gotcha:** under jsdom, `TextEncoder` returns a cross-realm
`Uint8Array`, so fflate's `strToU8` + `zipSync` fails its `instanceof` check and
emits one bogus entry per byte. Build zip fixtures with a same-realm
`Uint8Array.from(...)` (see `test/live2dBundle.test.ts`).

## Completing an incomplete bundle

`components/editor/Live2dBundleReportWindow.tsx` shows the report — required /
optional / manifest-error sections, each row naming the path the manifest
expected — and, when the bundle was *refused*, collects the missing files.

Partial state is **client-side**: the backend writes nothing on rejection, so
there is no pending-bundle store and no cleanup story for abandoned uploads. The
browser still holds the picked files (`pending`), the window gathers only the
stragglers, and `onRetry` re-posts the union. Nothing already chosen is
re-selected.

Supplied files match by **basename** — a bare `texture_00.png` fills the
`foo.2048/texture_00.png` slot, so the user never rebuilds the directory tree by
hand. Where one basename could fill several slots the window asks (a `select`
per leftover) rather than guessing; a wrong guess yields a model that loads
*looking* wrong, which is worse than one that does not load. Retry unlocks on
required slots alone — optional gaps never block.

### Repairing a rearranged bundle

The commonest broken bundle is not missing a file at all: it is a folder someone
rearranged, where everything is present but no longer where the manifest names
it (the `hiyori-main` case — `texture_00.png` at the root, manifest wanting
`hiyori_free_t08.2048/texture_00.png`).

`planRelocations(presentPaths, missingPaths, referencedPaths)` matches unresolved
references against files that ARE in the upload. `AssetManager` runs it when the
report arrives and seeds the window's slots, so a rearranged folder opens already
resolved. `applyRelocations` is not used by the window — it re-paths through the
same `supplied` machinery — but exists for any non-interactive caller.

Rules, each of which exists to avoid a wrong-looking model:

- Name match, **exact first**, case-insensitive only as a fallback (archives
  round-tripped through a case-insensitive filesystem). A case-only match sets
  `caseOnly` and the row says so.
- A file already at a path the manifest references is **never** a candidate — it
  is satisfying that reference where it is, and moving it would break it.
- A match is proposed only when unambiguous **in both directions**: one candidate
  for the slot, and that candidate wanted by no other slot. Everything else goes
  to `ambiguous`, rendered as a per-row `select`.
- Relocated files **move**, not copy: `retry` drops the original entry so the
  bundle doesn't carry the same bytes at both the right and the wrong path.

**The original plan ruled this out** — "guessing at a user's file layout silently
is how you get a model that loads wrong instead of not at all". That objection is
about *silence*, so the answer is visibility, not restraint: every filled row
names its source, a banner reports the count and asks the user to check, each
proposal has a `remove` that re-blocks the upload, and nothing is stored until
the user presses the button. Keep that property if you touch this.

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
