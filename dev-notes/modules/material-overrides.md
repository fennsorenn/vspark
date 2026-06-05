# Material Overrides (per-avatar Material Editor)

> Status: **Implemented**

Per-avatar Material Editor: each VRM avatar node gets a **Material** section in the
properties panel listing every material on the loaded model. Per material the user can
switch the shader between **MToon** (toon/NPR, the VRM default), **PBR**
(`MeshStandardMaterial`, basic metalness/roughness), and **APBR** ("Advanced PBR",
three's `MeshPhysicalMaterial` — a strict superset of PBR adding specular/clearcoat/sheen/
transmission/iridescence/anisotropy lobes), edit shader params, and reset to the
as-authored state.

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

Switching a material to PBR (or APBR) is the way to get real light falloff and full
darkness control on a VRM avatar; MToon stays available with explicit shade / shift /
toony tuning. APBR behaves like PBR for lighting (it *is* a `MeshStandardMaterial`
subclass) and renders identically to PBR until one of its advanced lobes is dialled up
(its lobe defaults match three's neutral values — see `APBR_DEFAULTS`). The editor
Viewport's studio light rig (ambient + directional) is left as-is.

The scene-level environment lighting still comes from the per-camera `envIntensity`
(drei `<Environment environmentIntensity>`); the per-material `envMapIntensity` control
(PBR + APBR) multiplies that contribution per material.

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
- **`MaterialOverride`** carries `shader: 'mtoon' | 'pbr' | 'apbr'` (`ShaderKind`) plus
  four param groups. All groups are kept across a shader switch — switching only *hides*
  the inactive params, never deletes them, so a round-trip is lossless.
  - **Overlap** (apply in every shader): `baseColor`, `emissive`, `emissiveIntensity`,
    `normalScale` (UI shown only if the material has a normal map), `doubleSided`,
    `alphaMode`, `alphaCutoff` (UI shown only in `mask` mode).
  - **MToon-only** (active only when `shader==='mtoon'`): `shadeColor`,
    `shadingShiftFactor`, `shadingToonyFactor`, `giEqualization` (→ `giEqualizationFactor`),
    `matcapColor` (→ `matcapFactor`), `rimColor`, `rimLightingMix`,
    `rimFresnelPower` (→ `parametricRimFresnelPowerFactor`),
    `rimLift` (→ `parametricRimLiftFactor`), plus `outlineWidth` / `outlineColor` /
    `outlineLightingMix` (→ `outlineLightingMixFactor`, applied to the outline material
    like outline width/color — UI shown only if the material has an outline).
  - **PBR + APBR shared** (active when `shader` is `pbr` or `apbr`): `roughness`
    (default `0.9` for anime models), `metalness` (default `0`), `envMapIntensity`
    (per-material multiplier on environment lighting, default `1`).
  - **APBR-only** (active only when `shader==='apbr'`, shown under a collapsible
    **Advanced** sub-group; `MeshPhysicalMaterial` lobes): `specularIntensity`,
    `specularColor`, `clearcoat`, `clearcoatRoughness`, `sheen`, `sheenRoughness`,
    `sheenColor`, `transmission`, `thickness`, `ior`, `attenuationColor`,
    `attenuationDistance` (`0` => `Infinity` / disabled), `iridescence`,
    `iridescenceIor` (→ `material.iridescenceIOR`), `anisotropy`. Defaults match three's
    neutral values (`APBR_DEFAULTS`) so APBR renders identically to PBR until a lobe is
    raised.
- Absent fields mean "use the value authored in the VRM file" (for native non-PBR-source
  fields, the neutral fallback in `readDefaults` / `APBR_DEFAULTS`).
- **Reset** deletes the whole entry for that material and rebuilds from the file — it is
  "reset to as-authored", not "reset to a hardcoded default".

## Apply layer — `components/editor/materialOverrides.ts`

Pure-ish module that, given a `vrm` + the `materialOverrides` record, mutates the scene's
live three.js materials to match.

- **Per-VRM slot registry**: cached in a module-level `WeakMap<VRM, Registry>`
  (`getRegistry` builds it lazily on first use). At build time it captures the as-authored
  defaults (`readDefaults`) and binds each surface material to its mesh slots — including
  the MToon outline material three-vrm pairs with the surface in the `mesh.material` array.
  This means MToon ⇄ PBR ⇄ APBR ⇄ reset never has to reconstruct MToon from scratch; the
  original authored material is held in `slot.source` and never disposed by us. The slot
  caches **both** a lazily-built `MeshStandardMaterial` (`slot.pbr`) and a
  `MeshPhysicalMaterial` (`slot.apbr`).
- **Param tweak within a shader** (`applyMToon` / `applyStandardCommon` / `applyAdvanced`):
  set the field on the existing material — `color`, `emissive`, `emissiveIntensity`,
  `normalScale`, plus MToon's `shadeColorFactor` / `shadingShiftFactor` /
  `shadingToonyFactor` / `giEqualizationFactor` / `matcapFactor` /
  `parametricRimColorFactor` / `rimLightingMixFactor` / `parametricRimFresnelPowerFactor` /
  `parametricRimLiftFactor` / `outlineWidthFactor` / `outlineColorFactor` /
  `outlineLightingMixFactor` (exact `@pixiv/three-vrm` v3 `MToonMaterial` names). The
  PBR/APBR shared params (`roughness` / `metalness` / `envMapIntensity`) go through
  `applyStandardCommon`; the APBR lobes through `applyAdvanced` (note `iridescenceIor` →
  `material.iridescenceIOR`, and `attenuationDistance` of `0` maps to `Infinity`). `side`
  and the alpha mode (`transparent` / `alphaTest`) flag a `needsUpdate` recompile when they
  change.
- **MToon → PBR / APBR** (`applyStandardLike` → `buildStandard` / `buildPhysical`): the
  `MeshStandardMaterial` (pbr) and `MeshPhysicalMaterial` (apbr) are each built **lazily
  once per slot** the first time the slot is switched to that mode, cached on `slot.pbr` /
  `slot.apbr` and reused — repeated switching never allocates more than one of each per slot
  (no GPU leak). Both are populated by `populateStandardFrom`, which carries the authored
  maps via **explicit field copies** (base-color map + factor, normal map + scale, emissive
  map + factor, and — for native-PBR sources — `aoMap`/`aoMapIntensity`, `roughnessMap`,
  `metalnessMap`) plus the transparency/alpha/side/depth/tone-mapping settings, then seeds
  the roughness/metalness defaults. **Explicit copies, not `Material.copy`**, are deliberate:
  `.copy` of a non-physical source into a `MeshPhysicalMaterial` would clobber its `defines`
  / read undefined physical-only fields.
- **MToon outline collapse**: three-vrm renders an outline as a *second material* in the
  `mesh.material` array (`[surface, outline]`, a duplicated geometry group). In PBR/APBR mode
  the outline material's `outlineWidthFactor` is set to `0` to collapse it; switching back to
  MToon restores the authored width (`originalOutlineWidth`).
- **PBR / APBR → MToon / Reset**: re-point each mesh slot at `slot.source` and restore
  outline params. Reset is just "drop the override entry" — `applyMaterialOverrides`
  re-derives everything from `override ?? authoredDefault`, so absence restores the
  as-authored look.
- **`applyMaterialOverrides` is idempotent**: every field is `override ?? authoredDefault`,
  so it can be called any number of times. Native (non-MToon) materials are kept on PBR/APBR
  — they can be either standard tier but can't become MToon (a `shader: 'mtoon'` on such a
  material is forced to `'pbr'`).
- **Disposal** (`disposeMaterialOverrides`): disposes **both** the lazily-built PBR
  (`slot.pbr`) and APBR (`slot.apbr`) materials and drops the WeakMap entry. Called from
  `Viewport.tsx` on VRM unload.

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
  material with a 3-way MToon/PBR/APBR segmented toggle (the MToon button is disabled for
  native non-MToon materials) and an expandable body showing the overlap params plus only
  the active shader's params (inactive shader's params hidden, not removed). The PBR+APBR
  shared `roughness`/`metalness`/`envMapIntensity` show whenever `shader` is `pbr` or
  `apbr`; the APBR-only lobes live under a nested collapsible **Advanced** disclosure.
  Normal scale appears only when the material has a normal map; alpha cutoff only in `mask`
  mode; outline width/color/mix only when the material has an outline. Per-material **Reset**
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
- **Native (non-MToon) materials can't switch to MToon** — they can be `pbr` or `apbr`,
  but not MToon (`supportsMToon` is false and `applyMaterialOverrides` forces a
  `shader: 'mtoon'` on such a material back to `'pbr'`).

## Out of scope

- Non-avatar materials (FBX props, particles).
- Backend / schema / DB / migration changes.
- Persisting section collapse state.

See [frontend.md](frontend.md) for the broader Viewport / PropertiesPanel context and
[scene-graph.md](scene-graph.md) for the `node.properties` mechanism.
