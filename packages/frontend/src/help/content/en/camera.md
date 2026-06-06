# Camera {#camera}

Camera properties control what a camera node sees, how it projects the scene onto the screen, and how environment lighting is weighted in the output.

## Field of view (FOV) {#fov}

Field of view is the angle of the cone that the camera captures, measured in degrees across the vertical extent of the frame. It only applies when the camera is set to **Perspective** projection.

- **Low values (e.g. 20–30°)** zoom in and compress depth — the avatar's face appears flatter and features farther apart look closer together. This is the telephoto or portrait effect.
- **High values (e.g. 70–90°)** show a wider area of the scene but exaggerate perspective: objects close to the camera appear large and objects further away shrink quickly.
- **Typical streaming range:** 40–60° gives a natural appearance. The default is 50°.

Changing FOV does not move the camera; combine it with the Position transform to reframe the shot.

## Projection {#projection}

Projection determines the geometric model used to map 3D space onto the flat image.

- **Perspective** — objects further from the camera appear smaller, matching how the human eye works. Use this for most avatar and scene shots. Default.
- **Orthographic** — objects appear the same size regardless of their distance from the camera; there is no vanishing point. Use this for UI-style overlays, flat top-down or side-on layouts, or when you want no perspective distortion.

When Orthographic is selected, the FOV field is replaced by a **Size** field (the half-height of the view in world units, default 2). Increasing Size zooms out; decreasing it zooms in.

## Near & far clipping {#clipping}

Near and far are the two depth planes that bound what the camera renders.

- **Near** — anything closer than this distance (in scene units) to the camera is not drawn. Default: 0.1. Setting it too low can cause flickering (z-fighting) on overlapping surfaces; setting it too high clips the front of close objects.
- **Far** — anything further than this distance is not drawn. Default: 1000. Reducing it can improve depth-buffer precision if z-fighting appears on distant objects; increasing it lets very large scenes stay visible.

If part of your scene unexpectedly disappears, check that it falls between these two values. For typical avatar use, the defaults work well.

## Environment intensity {#env}

Environment intensity is a multiplier (0–2) that scales the contribution of the environment map (the HDRI background or ambient cube) to the lighting of PBR and MToon materials in the scene.

- **1.0** — the environment lights the scene at full strength. Default.
- **Below 1.0** — the environment contribution is dimmed. Materials receive less fill light from indirect directions, increasing contrast and making scene lights more dominant.
- **0** — the environment map contributes no lighting. All light comes from explicit scene lights (point, directional, etc.).
- **Above 1.0** — the environment is brighter than normal, useful if your HDRI is dim and you want more ambient fill without changing scene lights.

This setting does not affect the visual background image; it only affects how materials are lit.
