# Camera Effects

Post-processing pipeline attached to camera nodes. Each effect is a DB row; the frontend `CameraEffects` component translates enabled rows into a `@react-three/postprocessing` `EffectComposer` pipeline.

## DB table — `camera_effects` (migration 003)

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| node_id | TEXT FK → scene_nodes | camera node; cascade delete |
| kind | TEXT | effect kind identifier (see below) |
| enabled | INTEGER | 0/1 |
| config | TEXT | JSON config specific to each kind |
| created_at, updated_at | TEXT | |

Index on `node_id`. One row per effect instance; a camera can have one of each kind.

## Backend routes

```
GET    /scene-nodes/:nodeId/effects
POST   /scene-nodes/:nodeId/effects    body: { kind, enabled?, config? }
PUT    /camera-effects/:id             body: { kind?, enabled?, config? }
DELETE /camera-effects/:id
```

Every mutation broadcasts a WebSocket message:
- `camera_effect_added` — full effect record
- `camera_effect_updated` — updated fields
- `camera_effect_removed` — `{ id }`

Frontend `useWsSync` applies these to the store in real time.

## Frontend — `Viewport.tsx` (`CameraEffects` component)

```tsx
export function CameraEffects({ forceNodeId?: string })
```

Reads `previewEffectsCamera` from the store (or uses `forceNodeId` override). Filters `cameraEffects` by that nodeId and `enabled === true`. Renders an `EffectComposer` with the matching effects.

**Helper accessors** (internal):
- `has(kind)` — true if that kind is enabled for this camera
- `get<T>(kind, key, fallback)` — reads a typed value from the effect's config

**Normal pass** is enabled when `has('fx_ssao') || has('fx_outline')` — these effects require the scene normal texture.

**Effect rendering order** (matters for compositing):
1. Color: BrightnessContrast, HueSaturation, Sepia
2. Bloom
3. Depth-based: SSAO, DepthOfField (with autofocus), ChromaticAberration
4. Edge: Outline (DepthEdgeEffect)
5. Distortion: Noise, Vignette, Scanline, Pixelation, ASCII, DotScreen, Glitch, TiltShift, Water
6. GodRays (requires a `godray_caster` node in the scene)
7. ToneMapping (always last)

**DOF autofocus**: Raycasts from the camera through a sampled set of screen points, collects hit distances from opaque scene geometry, then springs toward either a single target or a configurable percentile of distances. Runs at ~10 Hz. Updates `cocMaterial.focusDistance` imperatively.

**GodRays**: Looks up the active `godray_caster` node in `godrayCasterRegistry` to get the sun mesh reference. If no caster node is in the scene, the effect is skipped.

## Frontend — `PropertiesPanel.tsx` (effect config UI)

`EffectPanel` renders per-effect config UI. `EffectRow` is a shared numeric input with drag-to-adjust.

```tsx
function EffectRow({ label, cfg, field, step, min, max, onSave })
function EffectPanel({ effectId, kind })
```

On value change → `api.updateCameraEffect(effectId, { config })` → `PUT /camera-effects/:id`.

## Frontend — `SceneGraph.tsx` (effect controls)

Camera nodes in the scene tree show:
- **✦ button** — sets `previewEffectsCamera` to this nodeId, enabling the `CameraEffects` component in the viewport
- **CameraEffectsSection** — inline list of effects with enable toggle and remove button

`setPreviewEffectsCamera(null)` disables post-processing entirely (useful during performance-sensitive work).

## Effect kinds and config schemas

| Kind | Config fields | Notes |
|------|--------------|-------|
| `fx_tone_mapping` | `mode` (string) | ACES, AGX, Neutral, Reinhard, Cineon, Linear |
| `fx_bloom` | `intensity`, `luminanceThreshold`, `luminanceSmoothing` | |
| `fx_vignette` | `offset`, `darkness` | |
| `fx_depth_of_field` | `autofocus`, `afMode`, `afPointX/Y`, `afPercentile`, `afSpeed`, `afDelay`, `afOvershoot`, `worldFocusDistance`, `worldFocusRange`, `bokehScale` | autofocus toggle gates which params are active |
| `fx_chromatic_aberration` | `offsetX`, `offsetY` | |
| `fx_ssao` | `intensity`, `radius`, `bias`, `rings`, `samples` | requires normal pass |
| `fx_outline` | `color` (hex), `threshold`, `thickness`, `alpha`, `normalStrength`, `blendMode` | requires normal pass |
| `fx_brightness_contrast` | `brightness`, `contrast` | range ±1 |
| `fx_hue_saturation` | `hue`, `saturation` | hue range ±π |
| `fx_sepia` | `intensity` | 0–1 |
| `fx_noise` | `premultiply`, `blendFunction` | |
| `fx_scanline` | `density`, `opacity` | |
| `fx_pixelation` | `granularity` | |
| `fx_ascii` | `cellSize`, `color` | |
| `fx_dot_screen` | `angle`, `scale` | |
| `fx_glitch` | `delay`, `duration`, `strength` | |
| `fx_tilt_shift` | `offset`, `rotation`, `focusArea`, `feather` | |
| `fx_water` | `speed`, `amplitude`, `frequency`, `steepness` | |

Config is stored as-is in JSON; there is no server-side schema validation. The frontend `EffectPanel` handles defaults and type coercion.

## Adding a new effect kind

1. Add the kind string to `CAMERA_EFFECT_KINDS` in the frontend store
2. Add a rendering branch in `CameraEffects` in `Viewport.tsx`
3. Add a config UI block in `EffectPanel` in `PropertiesPanel.tsx`
4. No backend changes needed — the DB stores arbitrary JSON config
