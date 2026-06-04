/**
 * Per-avatar material override apply layer.
 *
 * Each VRM avatar node may carry `node.properties.materialOverrides`, a record
 * keyed by a stable {@link MaterialKey} that lets the user, per material:
 *   - switch the shader between MToon (the VRM default, toon/NPR) and PBR
 *     (three's `MeshStandardMaterial`, physically-based), and
 *   - tweak detailed shader params.
 *
 * MToon ignores environment/ambient lighting and has a built-in shade baseline,
 * so a MToon avatar never goes fully dark and the per-camera `envIntensity`
 * control does nothing to it. PBR mode gives real light falloff (and responds
 * to `envIntensity`); MToon mode stays available with explicit shade/shift/toony
 * tuning.
 *
 * Design:
 *   - We build a per-VRM "slot registry" once (lazily, cached in a WeakMap),
 *     caching the original authored materials so MToon -> PBR -> reset never has
 *     to reconstruct MToon from scratch.
 *   - The PBR material for a slot is built lazily the first time the slot is
 *     switched to PBR, then cached and reused — repeated switching never
 *     allocates more than one PBR material per slot (no GPU leak).
 *   - {@link applyMaterialOverrides} is idempotent: it re-derives every field
 *     from `override ?? authoredDefault`, so dropping an override field (or the
 *     whole entry — that's Reset) cleanly restores the as-authored value.
 *
 * ## Material keying (stable across reloads)
 *
 * Overrides must reattach to the same material after a page reload, so the key
 * must be stable for a given VRM file. We enumerate distinct *surface*
 * (non-outline) materials in depth-first traversal order (deterministic for a
 * file) and assign each a first-appearance index. The key is the material name
 * when that name is unique among distinct surface materials; otherwise we
 * disambiguate with the first-appearance index: `"<name>#<index>"` (and
 * `"material#<index>"` when the name is empty). A material instance shared by
 * several meshes collapses to a single key (and single override) — editing it
 * affects every mesh that uses it, which matches three's shared-material model.
 */
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

export type ShaderKind = 'mtoon' | 'pbr';
export type AlphaMode = 'opaque' | 'mask' | 'blend';

/** Stable per-material identity — see module header. */
export type MaterialKey = string;

/** User overrides for one material. Absent fields => use the authored value. */
export interface MaterialOverride {
  shader: ShaderKind;
  // Overlapping params — persist across a shader switch:
  baseColor?: string; // hex
  emissive?: string; // hex
  emissiveIntensity?: number;
  normalScale?: number;
  doubleSided?: boolean;
  alphaMode?: AlphaMode;
  alphaCutoff?: number;
  // MToon-specific (kept even when shader === 'pbr'):
  shadeColor?: string;
  shadingShiftFactor?: number;
  shadingToonyFactor?: number;
  rimColor?: string;
  rimLightingMix?: number;
  outlineWidth?: number;
  outlineColor?: string;
  // PBR-specific (kept even when shader === 'mtoon'):
  roughness?: number;
  metalness?: number;
}

export type MaterialOverrides = Record<MaterialKey, MaterialOverride>;

/** As-authored values for a material, used as UI fall-backs and for Reset. */
export interface MaterialDefaults {
  baseColor: string;
  emissive: string;
  emissiveIntensity: number;
  normalScale: number;
  hasNormalMap: boolean;
  doubleSided: boolean;
  alphaMode: AlphaMode;
  alphaCutoff: number;
  // MToon-only (present even for PBR-native materials, with neutral fallbacks):
  shadeColor: string;
  shadingShiftFactor: number;
  shadingToonyFactor: number;
  rimColor: string;
  rimLightingMix: number;
  outlineWidth: number;
  outlineColor: string;
  hasOutline: boolean;
  // PBR-only:
  roughness: number;
  metalness: number;
}

/** Lightweight per-material info for the properties panel. */
export interface MaterialSlotInfo {
  key: MaterialKey;
  displayName: string;
  /** The shader the material was authored with. */
  nativeShader: ShaderKind;
  /** Whether switching to MToon is possible (only if authored as MToon). */
  supportsMToon: boolean;
  defaults: MaterialDefaults;
}

/** PBR roughness default for anime/toon models converted to PBR. */
const DEFAULT_PBR_ROUGHNESS = 0.9;
const DEFAULT_PBR_METALNESS = 0;
const DEFAULT_ALPHA_CUTOFF = 0.5;

// ── internal registry ──────────────────────────────────────────────────────

interface MeshSlot {
  mesh: THREE.Mesh;
  /** Index of the surface material within `mesh.material` (0 when not an array). */
  surfaceIndex: number;
  /** True when `mesh.material` is an array (MToon outline produces `[surf, outline]`). */
  isArray: boolean;
  /** The MToon outline material added by three-vrm, if any. */
  outlineMat: MToonLike | null;
  /** Authored outline width, for restore after a PBR detour. */
  originalOutlineWidth: number;
}

interface Slot {
  key: MaterialKey;
  displayName: string;
  nativeShader: ShaderKind;
  /** The original authored material (never disposed by us). */
  source: THREE.Material;
  defaults: MaterialDefaults;
  meshes: MeshSlot[];
  /** Lazily built PBR material; cached for reuse across switches. */
  pbr: THREE.MeshStandardMaterial | null;
  /** Shader currently applied to the scene for this slot. */
  current: ShaderKind;
}

interface Registry {
  slots: Map<MaterialKey, Slot>;
}

/** Minimal structural type for the bits of MToonMaterial we touch. */
interface MToonLike extends THREE.Material {
  isMToonMaterial?: true;
  isOutline?: boolean;
  color: THREE.Color;
  normalMap: THREE.Texture | null;
  normalScale?: THREE.Vector2;
  emissive: THREE.Color;
  emissiveIntensity: number;
  emissiveMap: THREE.Texture | null;
  map: THREE.Texture | null;
  shadeColorFactor: THREE.Color;
  shadingShiftFactor: number;
  shadingToonyFactor: number;
  parametricRimColorFactor: THREE.Color;
  rimLightingMixFactor: number;
  outlineWidthFactor: number;
  outlineColorFactor: THREE.Color;
}

const registries = new WeakMap<VRM, Registry>();

function isMToon(mat: THREE.Material): mat is MToonLike {
  return (mat as MToonLike).isMToonMaterial === true;
}

function isOutlineMat(mat: THREE.Material): boolean {
  return (mat as MToonLike).isOutline === true;
}

function hex(c: THREE.Color | undefined): string {
  return c ? `#${c.getHexString()}` : '#ffffff';
}

function deriveAlphaMode(mat: THREE.Material): AlphaMode {
  if (mat.transparent) return 'blend';
  if (mat.alphaTest > 0) return 'mask';
  return 'opaque';
}

function readDefaults(source: THREE.Material): MaterialDefaults {
  const m = source as MToonLike & THREE.MeshStandardMaterial;
  const mtoon = isMToon(source);
  return {
    baseColor: hex(m.color),
    emissive: hex(m.emissive),
    emissiveIntensity: m.emissiveIntensity ?? 1,
    normalScale: m.normalScale?.x ?? 1,
    hasNormalMap: !!m.normalMap,
    doubleSided: source.side === THREE.DoubleSide,
    alphaMode: deriveAlphaMode(source),
    alphaCutoff: source.alphaTest > 0 ? source.alphaTest : DEFAULT_ALPHA_CUTOFF,
    shadeColor: mtoon ? hex(m.shadeColorFactor) : '#808080',
    shadingShiftFactor: mtoon ? m.shadingShiftFactor : 0,
    shadingToonyFactor: mtoon ? m.shadingToonyFactor : 0.9,
    rimColor: mtoon ? hex(m.parametricRimColorFactor) : '#000000',
    rimLightingMix: mtoon ? m.rimLightingMixFactor : 1,
    outlineWidth: mtoon ? m.outlineWidthFactor : 0,
    outlineColor: mtoon ? hex(m.outlineColorFactor) : '#000000',
    hasOutline: false, // patched in below once outline meshes are matched
    roughness: mtoon
      ? DEFAULT_PBR_ROUGHNESS
      : (m.roughness ?? DEFAULT_PBR_ROUGHNESS),
    metalness: mtoon
      ? DEFAULT_PBR_METALNESS
      : (m.metalness ?? DEFAULT_PBR_METALNESS),
  };
}

function buildRegistry(vrm: VRM): Registry {
  // First pass: enumerate distinct surface materials in traversal order and
  // count name occurrences so we can decide the keying scheme.
  const distinct: THREE.Material[] = [];
  const seen = new Set<THREE.Material>();
  const nameCounts = new Map<string, number>();

  vrm.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as THREE.Mesh).isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (isOutlineMat(mat)) continue;
      if (seen.has(mat)) continue;
      seen.add(mat);
      distinct.push(mat);
      nameCounts.set(mat.name, (nameCounts.get(mat.name) ?? 0) + 1);
    }
  });

  const keyFor = new Map<THREE.Material, MaterialKey>();
  distinct.forEach((mat, index) => {
    const unique = (nameCounts.get(mat.name) ?? 0) === 1 && mat.name !== '';
    keyFor.set(mat, unique ? mat.name : `${mat.name || 'material'}#${index}`);
  });

  const slots = new Map<MaterialKey, Slot>();
  for (const mat of distinct) {
    const key = keyFor.get(mat)!;
    slots.set(key, {
      key,
      displayName: mat.name || key,
      nativeShader: isMToon(mat) ? 'mtoon' : 'pbr',
      source: mat,
      defaults: readDefaults(mat),
      meshes: [],
      pbr: null,
      current: isMToon(mat) ? 'mtoon' : 'pbr',
    });
  }

  // Second pass: bind every mesh slot (and its outline material) to its slot.
  vrm.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as THREE.Mesh).isMesh || !mesh.material) return;
    const isArray = Array.isArray(mesh.material);
    const mats = isArray
      ? (mesh.material as THREE.Material[])
      : [mesh.material as THREE.Material];

    mats.forEach((mat, idx) => {
      if (isOutlineMat(mat)) return;
      const key = keyFor.get(mat);
      if (!key) return;
      const slot = slots.get(key)!;
      // three-vrm pairs each surface with a single outline clone in the array.
      const outlineMat =
        (mats.find((m) => isOutlineMat(m)) as MToonLike | undefined) ?? null;
      slot.meshes.push({
        mesh,
        surfaceIndex: idx,
        isArray,
        outlineMat,
        originalOutlineWidth: outlineMat?.outlineWidthFactor ?? 0,
      });
      if (outlineMat) slot.defaults.hasOutline = true;
    });
  });

  return { slots };
}

function getRegistry(vrm: VRM): Registry {
  let reg = registries.get(vrm);
  if (!reg) {
    reg = buildRegistry(vrm);
    registries.set(vrm, reg);
  }
  return reg;
}

// ── public API ─────────────────────────────────────────────────────────────

/** Enumerate a VRM's materials for the properties panel. */
export function getMaterialSlots(vrm: VRM): MaterialSlotInfo[] {
  const reg = getRegistry(vrm);
  return [...reg.slots.values()].map((s) => ({
    key: s.key,
    displayName: s.displayName,
    nativeShader: s.nativeShader,
    supportsMToon: s.nativeShader === 'mtoon',
    defaults: s.defaults,
  }));
}

/** Apply alpha mode to a base material; returns true if a recompile is needed. */
function applyAlpha(
  mat: THREE.Material,
  mode: AlphaMode,
  cutoff: number
): boolean {
  let transparent = false;
  let alphaTest = 0;
  if (mode === 'blend') transparent = true;
  else if (mode === 'mask') alphaTest = cutoff;
  let changed = false;
  if (mat.transparent !== transparent) {
    mat.transparent = transparent;
    changed = true;
  }
  if (mat.alphaTest !== alphaTest) {
    mat.alphaTest = alphaTest;
    changed = true;
  }
  return changed;
}

function applySide(mat: THREE.Material, doubleSided: boolean): boolean {
  const side = doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  if (mat.side !== side) {
    mat.side = side;
    return true;
  }
  return false;
}

function applyMToon(slot: Slot, ov: MaterialOverride | undefined): void {
  const d = slot.defaults;
  const m = slot.source as MToonLike;
  m.color.set(ov?.baseColor ?? d.baseColor);
  m.emissive.set(ov?.emissive ?? d.emissive);
  m.emissiveIntensity = ov?.emissiveIntensity ?? d.emissiveIntensity;
  if (m.normalScale) {
    const ns = ov?.normalScale ?? d.normalScale;
    m.normalScale.set(ns, ns);
  }
  m.shadeColorFactor.set(ov?.shadeColor ?? d.shadeColor);
  m.shadingShiftFactor = ov?.shadingShiftFactor ?? d.shadingShiftFactor;
  m.shadingToonyFactor = ov?.shadingToonyFactor ?? d.shadingToonyFactor;
  m.parametricRimColorFactor.set(ov?.rimColor ?? d.rimColor);
  m.rimLightingMixFactor = ov?.rimLightingMix ?? d.rimLightingMix;

  let recompile = false;
  recompile = applySide(m, ov?.doubleSided ?? d.doubleSided) || recompile;
  recompile =
    applyAlpha(
      m,
      ov?.alphaMode ?? d.alphaMode,
      ov?.alphaCutoff ?? d.alphaCutoff
    ) || recompile;
  if (recompile) m.needsUpdate = true;

  // Restore the surface material reference + outline widths on each mesh.
  const width = ov?.outlineWidth ?? d.outlineWidth;
  const outlineColor = ov?.outlineColor ?? d.outlineColor;
  for (const ms of slot.meshes) {
    if (ms.isArray) {
      (ms.mesh.material as THREE.Material[])[ms.surfaceIndex] = slot.source;
    } else {
      ms.mesh.material = slot.source;
    }
    if (ms.outlineMat) {
      ms.outlineMat.outlineWidthFactor = width;
      ms.outlineMat.outlineColorFactor.set(outlineColor);
    }
  }
  slot.current = 'mtoon';
}

function buildPbr(source: THREE.Material): THREE.MeshStandardMaterial {
  const std = new THREE.MeshStandardMaterial();
  std.name = `${source.name || 'material'} (PBR)`;
  if (isMToon(source)) {
    std.map = source.map;
    std.color.copy(source.color);
    std.normalMap = source.normalMap;
    if (source.normalScale) std.normalScale.copy(source.normalScale);
    std.emissive.copy(source.emissive);
    std.emissiveMap = source.emissiveMap;
    std.emissiveIntensity = source.emissiveIntensity;
  } else {
    std.copy(source as THREE.MeshStandardMaterial);
  }
  std.transparent = source.transparent;
  std.opacity = source.opacity;
  std.alphaTest = source.alphaTest;
  std.depthWrite = source.depthWrite;
  std.side = source.side;
  std.toneMapped = source.toneMapped;
  std.roughness = DEFAULT_PBR_ROUGHNESS;
  std.metalness = DEFAULT_PBR_METALNESS;
  return std;
}

function applyPbr(slot: Slot, ov: MaterialOverride | undefined): void {
  const d = slot.defaults;
  if (!slot.pbr) slot.pbr = buildPbr(slot.source);
  const p = slot.pbr;
  p.color.set(ov?.baseColor ?? d.baseColor);
  p.emissive.set(ov?.emissive ?? d.emissive);
  p.emissiveIntensity = ov?.emissiveIntensity ?? d.emissiveIntensity;
  if (p.normalMap) {
    const ns = ov?.normalScale ?? d.normalScale;
    p.normalScale.set(ns, ns);
  }
  p.roughness = ov?.roughness ?? d.roughness;
  p.metalness = ov?.metalness ?? d.metalness;

  let recompile = false;
  recompile = applySide(p, ov?.doubleSided ?? d.doubleSided) || recompile;
  recompile =
    applyAlpha(
      p,
      ov?.alphaMode ?? d.alphaMode,
      ov?.alphaCutoff ?? d.alphaCutoff
    ) || recompile;
  if (recompile) p.needsUpdate = true;

  // Point each mesh slot at the PBR material and collapse the toon outline.
  for (const ms of slot.meshes) {
    if (ms.isArray) {
      (ms.mesh.material as THREE.Material[])[ms.surfaceIndex] = p;
    } else {
      ms.mesh.material = p;
    }
    if (ms.outlineMat) ms.outlineMat.outlineWidthFactor = 0;
  }
  slot.current = 'pbr';
}

/**
 * Apply the full override record to a VRM's live materials. Idempotent: every
 * field is re-derived from `override ?? authoredDefault`, so removing a field or
 * an entire entry (Reset) restores the as-authored look. Materials with no
 * override fall back to MToon (their native shader) with authored params.
 */
export function applyMaterialOverrides(
  vrm: VRM,
  overrides: MaterialOverrides | undefined
): void {
  const reg = getRegistry(vrm);
  for (const slot of reg.slots.values()) {
    const ov = overrides?.[slot.key];
    // Native-PBR materials can't become MToon — keep them on PBR.
    const shader: ShaderKind =
      slot.nativeShader === 'pbr' ? 'pbr' : (ov?.shader ?? 'mtoon');
    if (shader === 'pbr') applyPbr(slot, ov);
    else applyMToon(slot, ov);
  }
}

/** Dispose any PBR materials we created for this VRM. Call on VRM unload. */
export function disposeMaterialOverrides(vrm: VRM): void {
  const reg = registries.get(vrm);
  if (!reg) return;
  for (const slot of reg.slots.values()) {
    slot.pbr?.dispose();
    slot.pbr = null;
  }
  registries.delete(vrm);
}
