# Live2D 2D avatars

Live2D Cubism avatars as a first-class scene entity, driven by the **same**
per-node tracking data that drives VRM `avatar` nodes (MediaPipe face, mic
lipsync, VMC/ARKit blendshapes, head pose) — no signal-graph changes, because
the per-node blendshape/pose broadcast bus already routes to a node's id.

> Status: implemented end-to-end **except in-browser rendering**, which was not
> verifiable in the headless dev environment. The runtime-only spots most likely
> to need tuning are flagged `// VERIFY` in `Live2DRuntime.ts` (MVP/projection
> fit, `flipY`/premultiplied-alpha, the `setRenderState` framebuffer target).

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
- `components/editor/PropertiesPanel.tsx` → `Live2DProperties` — model select +
  **directory upload** (`/assets/bundle`), transform/facing/auto-blink-breath,
  the **license-acceptance** block (writes `AppConfig` + consent gate), and the
  **parameter-override editor** (source field, gain, invert) populated from the
  model's discovered params (`live2dParamsByNode`).

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
  bundle (kind `live2d`), validates relPaths (no traversal), requires a
  `*.model3.json`, allocates a non-colliding dir under `live2d/`, and registers
  the manifest as an `asset_files` row.
- `routes/config.ts` — `PUT /config` accepts partial updates including
  `live2dLicenseAccepted` (persisted to `config.json`).

## Data flow (one frame)
1. A tracking component on the node writes blendshapes + a `neck` quaternion into
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
