# Plan: Per-avatar Material Editor (MToon ⇄ PBR)

> Branch: `feature/material-editor` · Status: ready-for-handoff
> This plan is the seed context for a cloud worker. It is a starting point, not an
> airtight spec — ask the user before guessing on anything underspecified.

## Goal

Give each VRM avatar node a **Material** section in the properties panel that lists every
material on the loaded model and lets the user, per material:

- switch the shader between **MToon** (toon/NPR, the VRM default) and **PBR**
  (`MeshStandardMaterial`, physically-based),
- expand the material to edit detailed shader params,
- reset the material back to its as-authored state.

The motivating problem: MToon ignores environment/ambient lighting and has a built-in
"shade" baseline, so an avatar's backside never goes fully dark and the per-camera
`envIntensity` control (already added) does nothing to VRM avatars. PBR mode gives real
light falloff and full darkness control; MToon mode stays available with explicit
shade/shift/toony tuning.

While here, also make the existing **Default Expression** section collapsible, and add the
new **Material** section as collapsible too. Both default to **collapsed**.

## Context: how things work today

- VRM avatars load via `VRMLoaderPlugin` in
  [packages/frontend/src/components/editor/Viewport.tsx](../../packages/frontend/src/components/editor/Viewport.tsx)
  (around line 940). Materials are MToon (`@pixiv/three-vrm` v3, `MToonMaterial`). Nothing
  in the pipeline currently modifies material params.
- The loaded `vrm` is stored in a `vrmRegistry` (`vrmRegistry.set(node.id, vrm)` in
  Viewport.tsx ~line 1003). Meshes are reachable via `vrm.scene.traverse(...)`.
- Avatar **look/behaviour** settings persist under **`node.properties`** (NOT
  `node.components`). See `defaultExpressions` / `blendTransitionTime` handling in
  [PropertiesPanel.tsx](../../packages/frontend/src/components/editor/PropertiesPanel.tsx)
  (~lines 5210–5314): they read `node.properties?.x`, write via
  `storeUpdateNode(node.id, { properties })` + `api.updateNode(node.id, { properties })`.
  **Follow this exact pattern for material overrides.**
- The properties panel uses a flat `sectionHeader` style (PropertiesPanel.tsx line ~172)
  for section titles — there is currently **no collapsible-section primitive**; sections
  are just `<div style={sectionHeader}>`. You will introduce a small reusable collapsible
  wrapper.
- MToon does **not** respond to `Environment` / `ambientLight`. The per-camera
  `envIntensity` control already added (CameraCanvas, ViewerPage, PropertiesPanel camera
  section) only affects PBR materials and non-VRM PBR meshes. Keep it — it becomes
  meaningful for PBR-mode avatars.

## Decisions already made (do not relitigate without asking)

- **Per-node overrides.** Stored on the model node, keyed so two nodes using the same VRM
  file can look different. Two avatars sharing a VRM may diverge — intended.
- **Shader switch preserves the other shader's params.** Overlapping params persist across
  a switch; shader-specific params for the *inactive* shader are kept in the stored object
  (hidden, not deleted).
- **Reset = drop the override and rebuild from the VRM file** (original MToon values,
  original shader). Not "reset to a hardcoded default."
- **Collapsible Material + Expression sections, both default collapsed.**
- Keep the `envIntensity` camera control.

## Data model

Store on `node.properties.materialOverrides`, keyed by a **stable material identity**.
Material `name` is the natural key, but VRM models can have duplicate / empty material
names — resolve this early. Recommended key: prefer `material.name` when unique within the
model; otherwise fall back to a composite like `<meshName>::<materialIndex>`. **Decide the
keying scheme first and write it down** — it must be stable across reloads or overrides
won't reattach.

```ts
// node.properties.materialOverrides: Record<MaterialKey, MaterialOverride>
interface MaterialOverride {
  shader: 'mtoon' | 'pbr';
  // Overlapping params — persist across shader switch:
  baseColor?: string;        // hex
  emissive?: string;         // hex
  emissiveIntensity?: number;
  normalScale?: number;
  doubleSided?: boolean;
  alphaMode?: 'opaque' | 'mask' | 'blend';
  alphaCutoff?: number;
  // MToon-specific (kept even when shader==='pbr'):
  shadeColor?: string;
  shadingShiftFactor?: number;
  shadingToonyFactor?: number;
  rimColor?: string;
  rimLightingMix?: number;
  outlineWidth?: number;
  outlineColor?: string;
  // PBR-specific (kept even when shader==='mtoon'):
  roughness?: number;        // default ~0.9 for anime models
  metalness?: number;        // default 0
}
```

Absent fields mean "use the value authored in the VRM file". Only persist fields the user
actually changed where practical, so Reset (= delete the whole entry) is clean.

## Approach

### 1. Collapsible section primitive
Add a small `CollapsibleSection` component (local to PropertiesPanel or a sibling file):
header row with a disclosure caret + title (+ optional count), toggling a `useState`
boolean, children hidden when collapsed. Reuse `sectionHeader` styling so it looks native.
Apply it to:
- the existing **Default Expression** section (~PropertiesPanel.tsx:5186), default collapsed,
- the new **Material** section, default collapsed.

(Collapse state is ephemeral UI state — does **not** need persisting.)

### 2. Enumerate materials
For the selected avatar node, get its `vrm` from `vrmRegistry` (expose a getter if not
already reachable from PropertiesPanel). Traverse `vrm.scene`, collect unique materials
with their resolved `MaterialKey`, current shader (MToon instance vs standard), and
display name. Render one collapsible row per material inside the Material section.

If the VRM isn't loaded yet (registry miss), show nothing / a "loading" note — mirror how
expressions guard on `vrmExpressionsByNode[node.id]`.

### 3. Per-material UI
Each material row: a shader toggle (MToon / PBR segmented control) + an expandable body.
In the body show **only the params for the selected shader**, plus the overlapping params.
Hide (do not remove from state) the other shader's params. Param controls follow existing
panel idioms (color input, range slider + numeric readout like the new Environment
control, checkbox for doubleSided, select for alphaMode). Include a **Reset** button that
deletes the override entry for that material and rebuilds from the file.

Suggested param sets:
- **Overlap (persist across switch):** baseColor, emissive, emissiveIntensity,
  normalScale, doubleSided, alphaMode, alphaCutoff.
- **MToon only:** shadeColor, shadingShiftFactor, shadingToonyFactor, rimColor,
  rimLightingMix, outlineWidth, outlineColor.
- **PBR only:** roughness, metalness.

### 4. Apply overrides to the live three.js materials
This is the bulk of the work. Create a module (e.g.
`packages/frontend/src/components/editor/materialOverrides.ts`) that, given a `vrm` and the
`materialOverrides` record, mutates the scene's materials to match. Called:
- once after VRM load (in Viewport.tsx, after `vrmRegistry.set`), and
- whenever the override record changes for that node (subscribe to store, or re-run on the
  same signal that drives re-render).

Behaviours:
- **Param tweak within the same shader:** set the corresponding field on the existing
  material (`material.color`, `emissive`, `roughness`, MToon's `shadeColorFactor`,
  `shadingShiftFactor`, `shadingToonyFactor`, `rimLightingMixFactor`, etc.). Verify exact
  `@pixiv/three-vrm` v3 `MToonMaterial` property names against the installed package.
- **MToon → PBR:** build a `MeshStandardMaterial` carrying over base color map + factor,
  normal map (+ scale), emissive map + factor, transparency/alpha settings; apply
  roughness (default ~0.9) and metalness (default 0). Replace the mesh's material.
  **Hide the MToon outline meshes** three-vrm adds (outline is separate geometry) while in
  PBR mode. Keep enough handle on the original to restore on switch-back / reset.
- **PBR → MToon / Reset:** restore the original authored MToon material (and outline).
  Cleanest implementation: **cache the original materials at load time** (clone or keep
  references) so MToon ⇄ PBR ⇄ reset never has to reconstruct MToon from scratch. Dispose
  materials you replace to avoid GPU leaks.

Texture carry-over and outline handling are the most edge-case-prone parts — go carefully
and surface anything ambiguous to the user rather than guessing.

### 5. Persistence wiring
Read from `node.properties?.materialOverrides`. On any edit, merge and write via
`storeUpdateNode(node.id, { properties })` + `api.updateNode(node.id, { properties })`,
exactly like `defaultExpressions`. Reset deletes the per-material entry.

## Files in scope

- `packages/frontend/src/components/editor/PropertiesPanel.tsx` — collapsible primitive;
  make Expression section collapsible; new Material section + per-material UI + persistence.
- `packages/frontend/src/components/editor/materialOverrides.ts` (**new**) — pure-ish apply
  layer: given `vrm` + overrides, mutate/swap materials; cache originals; MToon⇄PBR
  conversion; dispose replaced materials.
- `packages/frontend/src/components/editor/Viewport.tsx` — invoke the apply layer after VRM
  load and on override changes; ensure `vrm` (or a getter) is reachable to PropertiesPanel.
- Possibly `packages/frontend/src/store/editorStore.ts` — only if a getter/selector is
  needed to reach the loaded `vrm` or to react to override changes.
- `dev-notes/` — spawn the `doc-updater` agent on completion to record the material-editor
  feature and the MToon-vs-PBR rendering note.

## Out of scope

- The editor Viewport's built-in studio light rig (ambient+directional) — leave as-is.
- Non-avatar materials (FBX props, particles, etc.).
- Any backend / schema / DB changes — `node.properties` is already a free-form JSON blob;
  no migration needed. Confirm this holds (check how `properties` is validated/stored) and
  flag if a schema actually gates it.
- Saving collapse (expanded/collapsed) state across reloads.

## Acceptance / verification

- `pnpm lint` passes, and `pnpm --filter @vspark/frontend exec tsc --noEmit` is clean
  (frontend is not in the root `lint` scope — type-check it directly).
- Material section lists all of a loaded VRM's materials; Expression + Material sections
  collapse/expand and default collapsed.
- Switching a material to **PBR** makes it respond to scene lights + `envIntensity`: with
  no in-range lights the avatar goes fully dark; backside darkens with directional light.
- Switching back to **MToon** restores the toon look (outline returns).
- Editing params updates the viewport live and survives a page reload (persisted).
- **Reset** returns a material to its as-authored state and removes the stored override.
- No obvious GPU material leaks on repeated switching (dispose replaced materials).

## Output

Open a PR into `dev` when done.
