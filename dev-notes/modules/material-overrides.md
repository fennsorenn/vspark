# Material Overrides (per-avatar Material Editor)

> Status: **WIP** (branch `claude/relaxed-wozniak-Sv6sT`)

Per-avatar Material Editor: each VRM avatar node gets a **Material** section in the
properties panel listing every material on the loaded model. Per material the user can
switch the shader between **MToon** (toon/NPR, the VRM default) and **PBR**
(`MeshStandardMaterial`), edit shader params, and reset to the as-authored state.

Frontend-only feature. No backend, schema, DB, or WS changes — overrides ride on the
existing free-form `node.properties` JSON blob (same mechanism as `defaultExpressions` /
`blendTransitionTime`, the `scene_nodes.properties` column from migration 007).

## Why MToon vs PBR matters

MToon and PBR react to scene lighting completely differently — this distinction is the
whole point of the feature:

- **MToon** (NPR/toon): ignores environment/ambient lighting and carries a built-in
  "shade" baseline, so an avatar's backside never goes fully dark. The per-camera
  `envIntensity` control has **no effect** on MToon materials.
- **PBR** (`MeshStandardMaterial`, physically based): responds to scene lights and the
  per-camera `envIntensity` control. With no in-range lights an avatar in PBR mode goes
  fully dark; a directional light darkens the backside realistically.

Switching a material to PBR is the way to get real light falloff and full darkness
control on a VRM avatar; MToon stays available with explicit shade / shift / toony tuning.
The editor Viewport's studio light rig (ambient + directional) is left as-is.

## Data model

Stored on `node.properties.materialOverrides`: `Record<MaterialKey, MaterialOverride>`.

- **Key (`MaterialKey`)** must be stable across reloads or overrides won't reattach.
  Material `name` is the natural key but VRM models can have duplicate / empty names, so
  the apply layer resolves a stable key (prefer unique `material.name`, else a composite
  like `<meshName>::<materialIndex>`). The exact scheme is decided in the implementation —
  see `materialOverrides.ts`.
- **`MaterialOverride`** carries `shader: 'mtoon' | 'pbr'` plus three param groups:
  - **Overlap** (persist across a shader switch): `baseColor`, `emissive`,
    `emissiveIntensity`, `normalScale`, `doubleSided`, `alphaMode`, `alphaCutoff`.
  - **MToon-only** (kept even when `shader==='pbr'`): `shadeColor`, `shadingShiftFactor`,
    `shadingToonyFactor`, `rimColor`, `rimLightingMix`, `outlineWidth`, `outlineColor`.
  - **PBR-only** (kept even when `shader==='mtoon'`): `roughness` (default ~0.9 for anime
    models), `metalness` (default 0).
- Absent fields mean "use the value authored in the VRM file". Switching shader hides (does
  not delete) the inactive shader's params, so a round-trip is lossless.
- **Reset** deletes the whole entry for that material and rebuilds from the file — it is
  "reset to as-authored", not "reset to a hardcoded default".

## Apply layer — `components/editor/materialOverrides.ts`

Pure-ish module that, given a `vrm` + the `materialOverrides` record, mutates the scene's
live three.js materials to match.

- **Per-VRM slot registry**: caches the original (as-authored) materials at load time,
  keyed by `MaterialKey`, so MToon ⇄ PBR ⇄ reset never has to reconstruct MToon from
  scratch.
- **Param tweak within a shader**: set the field on the existing material
  (`material.color`, `emissive`, `roughness`, and MToon's `shadeColorFactor` /
  `shadingShiftFactor` / `shadingToonyFactor` / `rimLightingMixFactor`, etc. — exact
  `@pixiv/three-vrm` v3 `MToonMaterial` names verified against the installed package).
- **MToon → PBR**: build a `MeshStandardMaterial` carrying over base color map + factor,
  normal map (+ scale), emissive map + factor, and transparency/alpha settings; apply
  roughness/metalness defaults; replace the mesh material. **Hide the MToon outline meshes**
  three-vrm adds (outline is separate geometry) while in PBR mode.
- **PBR → MToon / Reset**: restore the cached original MToon material (and outline).
- **Disposal**: dispose materials created/replaced by the layer to avoid GPU leaks.

Called from `Viewport.tsx`:
- once after VRM load (after `vrmRegistry.set`), and
- whenever the override record changes for that node.

Texture carry-over and outline handling are the most edge-case-prone parts.

## Properties panel — `components/editor/PropertiesPanel.tsx`

- Introduces a small reusable **collapsible-section primitive** (disclosure caret + title +
  optional count) reusing the existing flat `sectionHeader` styling. Collapse state is
  ephemeral UI state, not persisted.
- New **Material** section: one collapsible row per material with a MToon/PBR segmented
  toggle and an expandable body showing only the active shader's params plus the overlap
  params (inactive shader's params hidden, not removed). Per-material **Reset** button.
  Guards on the VRM being loaded (registry hit) — mirrors how the expression list guards on
  `vrmExpressionsByNode[node.id]`.
- The existing **Default Expression** section is made collapsible too. Both sections
  default to **collapsed**.
- Persistence follows the `defaultExpressions` pattern exactly: read from
  `node.properties?.materialOverrides`; on edit, merge and write via
  `storeUpdateNode(node.id, { properties })` + `api.updateNode(node.id, { properties })`.

## Out of scope

- Non-avatar materials (FBX props, particles).
- Backend / schema / DB / migration changes.
- Persisting section collapse state.

See [frontend.md](frontend.md) for the broader Viewport / PropertiesPanel context and
[scene-graph.md](scene-graph.md) for the `node.properties` mechanism.
