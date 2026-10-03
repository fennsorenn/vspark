# Live2D — remaining work (handoff to a local session)

> Branch: `claude/epic-volta-QBoUm` (already has `dev` merged in).
> Audience: a **local** Claude Code session with more permissions than the cloud
> session that built this — specifically: a real **browser** (to verify
> rendering), **`workflow` scope** (to edit `.github/workflows/`), and the
> ability to fetch a real Live2D model bundle for testing.
>
> The Live2D feature is **built and merged** — adapter, scene node, asset
> ingestion, param mapping, license gate, docs. Everything compiles
> (`pnpm lint` + frontend `typecheck` + full `vite build`, framework code-splits
> cleanly). What's left is the work the cloud session **couldn't do headlessly
> or lacked permission for**. See [../modules/live2d.md](../modules/live2d.md)
> for the architecture.

## First: make the submodule present

The Cubism Web Framework is a git submodule and is **not** cloned with a plain
checkout:

```bash
git submodule update --init --recursive
```

Without it, `vite build` / `vite dev` can't resolve `@cubism/framework/*`
(tsc still passes — it uses the ambient `.d.ts`).

---

## 1. CI: check out submodules  ·  *needs `workflow` scope*

`.github/workflows/ci.yml`'s `build` job uses `actions/checkout@v4` with no
`submodules` option, so CI can't resolve the framework alias and `vite build`
will fail. Add:

```yaml
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
```

The cloud session's OAuth token lacked `workflow` scope and could not push this.
Acceptance: CI `build` job goes green on the branch.

---

## 2. Verify (and fix) Live2D rendering in a browser  ·  *needs a browser + a model*

The adapter (`packages/frontend/src/lib/puppet2d/live2d/Live2DRuntime.ts`) was
written against the real framework API (signatures verified against the
submodule source) but **never run** — the cloud env is headless. The GL/render
path is the part most likely to be subtly wrong on first contact.

**Setup to exercise it:**
1. `pnpm dev`, open a project.
2. Asset dock → **Models** tab → **Upload Live2D** → pick a Cubism model folder
   (a directory containing `*.model3.json` + `.moc3` + textures). Sample models:
   Live2D's free "Hiyori"/"Mark" sample bundles.
3. The first time, the properties panel for a `live2d` node shows a license
   block — click **Accept Live2D license** (persists `AppConfig`, lets the Core
   load). For a quick manual unblock you can also run
   `localStorage.setItem('vspark.live2d.accepted','1')` in the console.
4. **Add to Scene** from the asset card. Watch the viewport + console.

**The three `// VERIFY:` spots, in `Live2DRuntime.ts`:**
- **Projection fit** (`renderFrame`, ~L194): `proj.scale(1, w/h)` then
  `multiplyByMatrix(getModelMatrix())` is a rough guess. The model will likely be
  mis-scaled/off-center until this matches the model's canvas dimensions
  (`getModel().getCanvasWidth()/Height()`). Compare with the official
  CubismWebSamples `LAppView`/`CubismMatrix44` setup.
- **flipY / premultiplied alpha** (constructor, ~L76): the off-screen GL canvas
  feeds a `THREE.CanvasTexture`. Live2D's premultiplied output + GL's
  bottom-left origin may need `texture.flipY` and/or `premultiplyAlpha` flipped,
  or the plane will look inverted / have dark fringes.
- **Render-state framebuffer** (`renderFrame`): `renderer.setRenderState(null, …)`
  draws to the canvas default framebuffer. If clipping masks render wrong, the
  renderer may need an explicit FBO + mask buffer size.

**Driving it:** attach a `mediapipe_tracker` or `lipsync` behavior to the node;
`mapToLive2dParams` (`lib/live2dParamMap.ts`) should move eyes/mouth/brows/head.
Tune per-parameter overrides in the node's Properties → Parameter mapping editor.

Acceptance: a model renders upright, correctly framed, and lip-syncs/blinks/turns
from a tracking behavior. Remove the `// VERIFY` comments as each is confirmed
and fold any fixes back into [../modules/live2d.md](../modules/live2d.md).

---

## 3. Wire auto-blink / breath / idle motion  ·  *follow-up feature*

The `live2d` node has `autoBlink` / `autoBreath` config (defaults in
`createKinds.ts` `LIVE2D_DEFAULTS`, toggles in `Live2DProperties`) but they're
**inert** — nothing consumes them. The Cubism framework ships the building
blocks on the `CubismUserModel` base:
- `CubismEyeBlink`, `CubismBreath` (`@cubism/framework/effect/*`),
- motion playback (`CubismMotionManager` + `.motion3.json` from the model3
  settings), and expressions.

Plan: in `Live2DRuntime`, after `update()` of params but before draw, run the
enabled effects (gated by the node config, threaded through `load`/a setter).
Add the ambient declarations for the effect classes to
`src/types/cubism-framework.d.ts` as you use them. Idle `.motion3.json` files in
the bundle are already uploaded by the bundle endpoint, so they're on disk.

Acceptance: with no tracking attached, the model idle-blinks and breathes; motion
clips (if present in the bundle) can play.

---

## 4. Optional polish
- **License UX:** acceptance is currently an inline block in the Live2D
  properties panel (writes `AppConfig.live2dLicenseAccepted`). A first-class
  modal on first Core use would be nicer, but the gate is functional.
- **Inochi2D seam:** `Puppet2DRuntime` (`lib/puppet2d/types.ts`) is the adapter
  interface; a second 2D runtime would slot in beside `Live2DRuntime` selected by
  bundle format in `Live2DNode`. Explicitly out of scope for v1 — noted so the
  abstraction isn't accidentally collapsed.

---

## Where things live (quick map)
- Adapter / Core loader / ambient types:
  `packages/frontend/src/lib/puppet2d/live2d/{Live2DRuntime,coreLoader}.ts`,
  `src/types/cubism-framework.d.ts`
- Mapping: `packages/frontend/src/lib/live2dParamMap.ts`
- Scene node: `Viewport.tsx` → `Live2DNode`; properties: `PropertiesPanel.tsx` →
  `Live2DProperties`
- Asset ingestion: `AssetManager.tsx` (Models tab), `createKinds.ts`
  (`createNodeFromLive2dAsset`, `LIVE2D_DEFAULTS`), `dnd.ts`
- Build wiring: `vite.config.ts` (`@cubism/framework/*` alias), submodule at
  `packages/frontend/vendor/CubismWebFramework`
- Backend: `routes/assets.ts` (`/assets/bundle`), `routes/config.ts`
  (`live2dLicenseAccepted`)
- Full picture: [../modules/live2d.md](../modules/live2d.md)
