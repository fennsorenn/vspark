# Material Overrides (per-avatar Material Editor)

> Status: **Implemented**

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
  The apply layer enumerates distinct **surface** (non-outline) materials in
  depth-first traversal order (deterministic for a file) and assigns each a
  first-appearance index. The key is `material.name` when that name is unique among the
  distinct surface materials; otherwise it disambiguates with the index: `<name>#<index>`
  (and `material#<index>` when the name is empty). A material instance shared by several
  meshes collapses to a single key (and single override) — editing it affects every mesh
  that uses it, matching three's shared-material model.
- **`MaterialOverride`** carries `shader: 'mtoon' | 'pbr'` plus three param groups:
  - **Overlap** (persist across a shader switch): `baseColor`, `emissive`,
    `emissiveIntensity`, `normalScale` (UI shown only if the material has a normal map),
    `doubleSided`, `alphaMode`, `alphaCutoff` (UI shown only in `mask` mode).
  - **MToon-only** (kept even when `shader==='pbr'`): `shadeColor`, `shadingShiftFactor`,
    `shadingToonyFactor`, `rimColor`, `rimLightingMix`, plus `outlineWidth` / `outlineColor`
    (UI shown only if the material has an outline).
  - **PBR-only** (kept even when `shader==='mtoon'`): `roughness` (default `0.9` for anime
    models), `metalness` (default `0`).
- Absent fields mean "use the value authored in the VRM file". Switching shader hides (does
  not delete) the inactive shader's params, so a round-trip is lossless.
- **Reset** deletes the whole entry for that material and rebuilds from the file — it is
  "reset to as-authored", not "reset to a hardcoded default".

## Apply layer — `components/editor/materialOverrides.ts`

Pure-ish module that, given a `vrm` + the `materialOverrides` record, mutates the scene's
live three.js materials to match.

- **Per-VRM slot registry**: cached in a module-level `WeakMap<VRM, Registry>`
  (`getRegistry` builds it lazily on first use). At build time it captures the as-authored
  defaults (`readDefaults`) and binds each surface material to its mesh slots — including
  the MToon outline material three-vrm pairs with the surface in the `mesh.material` array.
  This means MToon ⇄ PBR ⇄ reset never has to reconstruct MToon from scratch; the original
  authored material is held in `slot.source` and never disposed by us.
- **Param tweak within a shader** (`applyMToon` / `applyPbr`): set the field on the
  existing material — `color`, `emissive`, `emissiveIntensity`, `normalScale`, plus MToon's
  `shadeColorFactor` / `shadingShiftFactor` / `shadingToonyFactor` /
  `parametricRimColorFactor` / `rimLightingMixFactor` / `outlineWidthFactor` /
  `outlineColorFactor` (exact `@pixiv/three-vrm` v3 `MToonMaterial` names). `side` and the
  alpha mode (`transparent` / `alphaTest`) flag a `needsUpdate` recompile when they change.
- **MToon → PBR** (`buildPbr`): a `MeshStandardMaterial` is built **lazily once per slot**
  the first time the slot is switched to PBR, then cached on `slot.pbr` and reused — repeated
  switching never allocates more than one PBR material per slot (no GPU leak). It carries
  over the base-color map + factor, normal map (+ scale), emissive map + factor, and the
  transparency/alpha/side/depth/tone-mapping settings, then applies the
  roughness/metalness defaults.
- **MToon outline collapse**: three-vrm renders an outline as a *second material* in the
  `mesh.material` array (`[surface, outline]`, a duplicated geometry group). In PBR mode the
  outline material's `outlineWidthFactor` is set to `0` to collapse it; switching back to
  MToon restores the authored width (`originalOutlineWidth`).
- **PBR → MToon / Reset**: re-point each mesh slot at `slot.source` and restore outline
  widths. Reset is just "drop the override entry" — `applyMaterialOverrides` re-derives
  everything from `override ?? authoredDefault`, so absence restores the as-authored look.
- **`applyMaterialOverrides` is idempotent**: every field is `override ?? authoredDefault`,
  so it can be called any number of times. Native-PBR materials are kept on PBR (they can't
  become MToon).
- **Disposal** (`disposeMaterialOverrides`): disposes the lazily-built PBR materials and
  drops the WeakMap entry. Called from `Viewport.tsx` on VRM unload.

Called from `Viewport.tsx`:
- once after VRM load, and
- whenever `node.properties.materialOverrides` changes — the effect is keyed on
  `JSON.stringify(materialOverrides)`, and the VRM-loaded signal is `vrmBonesByNode`
  (bones are set on load, cleared on unload).

Texture carry-over and outline handling are the most edge-case-prone parts.

## Properties panel — `components/editor/PropertiesPanel.tsx`

- Introduces a small reusable **`CollapsibleSection`** primitive (disclosure caret + title +
  optional count) reusing the existing flat `sectionHeader` styling. `defaultCollapsed`
  defaults to `true`; collapse state is ephemeral UI state, not persisted.
- New **Material** section (`MaterialSection` → `MaterialRow`): one collapsible row per
  material with a MToon/PBR segmented toggle and an expandable body showing the overlap
  params plus only the active shader's params (inactive shader's params hidden, not removed).
  Normal scale appears only when the material has a normal map; alpha cutoff only in `mask`
  mode; outline width/color only when the material has an outline. Per-material **Reset**
  button (disabled when there's no override). Guards on the VRM being loaded via
  `vrmBonesByNode[node.id]` (mirrors how the expression list guards on the VRM-loaded
  signal).
- The existing **Default Expression** section is wrapped in `CollapsibleSection` too. Both
  the Default Expression and Material sections default to **collapsed**.
- Persistence follows the `defaultExpressions` pattern exactly: read from
  `node.properties?.materialOverrides`; on edit, merge and write via
  `storeUpdateNode(node.id, { properties })` + `api.updateNode(node.id, { properties })`.

## Known limitations

- A material **authored without an outline cannot gain one** via the outline width control —
  there is no second geometry group to drive, so the outline UI is hidden for those
  materials.
- **Native (non-MToon) materials can't switch to MToon** — they're pinned to PBR
  (`supportsMToon` is false and `applyMaterialOverrides` forces `shader: 'pbr'`).

## Out of scope

- Non-avatar materials (FBX props, particles).
- Backend / schema / DB / migration changes.
- Persisting section collapse state.

See [frontend.md](frontend.md) for the broader Viewport / PropertiesPanel context and
[scene-graph.md](scene-graph.md) for the `node.properties` mechanism.
