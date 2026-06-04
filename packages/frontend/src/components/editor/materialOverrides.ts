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

/**
 * Shader modes:
 *   - `mtoon` — the VRM toon/NPR default (`MToonMaterial`).
 *   - `pbr`   — physically-based metalness/roughness (`MeshStandardMaterial`).
 *   - `apbr`  — "advanced PBR": `MeshPhysicalMaterial`, a strict superset of PBR
 *               that adds specular, clearcoat, sheen, transmission, iridescence,
 *               anisotropy and IOR controls.
 */
export type ShaderKind = 'mtoon' | 'pbr' | 'apbr';
export type AlphaMode = 'opaque' | 'mask' | 'blend';
/**
 * Which texture modulates the emissive factor:
 *   - `original` — the authored emissive texture (glTF/MToon default).
 *   - `flat`     — none; the emissive color/intensity show everywhere.
 *   - `albedo`   — the base-color (albedo) texture, so the material emits its
 *                  own diffuse pattern tinted by the emissive color.
 */
export type EmissiveMapMode = 'original' | 'flat' | 'albedo';

/** Stable per-material identity — see module header. */
export type MaterialKey = string;

/** User overrides for one material. Absent fields => use the authored value. */
export interface MaterialOverride {
  shader: ShaderKind;
  // Overlapping params — persist across a shader switch:
  baseColor?: string; // hex
  emissive?: string; // hex
  emissiveIntensity?: number;
  /** Which texture modulates the emissive factor — see {@link EmissiveMapMode}.
   *  Default `original`. */
  emissiveMapMode?: EmissiveMapMode;
  normalScale?: number;
  /** Blend authored vertex normals (0) toward fully smoothed normals (1). */
  normalSmoothing?: number;
  /** Faceted shading via per-fragment face normals (overrides smoothing). */
  flatShading?: boolean;
  doubleSided?: boolean;
  alphaMode?: AlphaMode;
  alphaCutoff?: number;
  /** Material opacity (0..1); < 1 forces the material transparent. */
  opacity?: number;
  // MToon-specific (kept even when shader is pbr/apbr):
  shadeColor?: string;
  shadingShiftFactor?: number;
  shadingToonyFactor?: number;
  giEqualization?: number;
  matcapColor?: string;
  rimColor?: string;
  rimLightingMix?: number;
  rimFresnelPower?: number;
  rimLift?: number;
  outlineWidth?: number;
  outlineColor?: string;
  outlineLightingMix?: number;
  // PBR + APBR (kept even when shader === 'mtoon'):
  roughness?: number;
  metalness?: number;
  envMapIntensity?: number;
  // APBR-only (MeshPhysicalMaterial lobes):
  specularIntensity?: number;
  specularColor?: string;
  clearcoat?: number;
  clearcoatRoughness?: number;
  sheen?: number;
  sheenRoughness?: number;
  sheenColor?: string;
  transmission?: number;
  thickness?: number;
  ior?: number;
  attenuationColor?: string;
  attenuationDistance?: number; // 0 => disabled (Infinity)
  iridescence?: number;
  iridescenceIor?: number;
  anisotropy?: number;
}

export type MaterialOverrides = Record<MaterialKey, MaterialOverride>;

/** As-authored values for a material, used as UI fall-backs and for Reset. */
export interface MaterialDefaults {
  baseColor: string;
  emissive: string;
  emissiveIntensity: number;
  hasEmissiveMap: boolean;
  normalScale: number;
  hasNormalMap: boolean;
  flatShading: boolean;
  doubleSided: boolean;
  alphaMode: AlphaMode;
  alphaCutoff: number;
  opacity: number;
  // MToon-only (present even for PBR-native materials, with neutral fallbacks):
  shadeColor: string;
  shadingShiftFactor: number;
  shadingToonyFactor: number;
  giEqualization: number;
  matcapColor: string;
  rimColor: string;
  rimLightingMix: number;
  rimFresnelPower: number;
  rimLift: number;
  outlineWidth: number;
  outlineColor: string;
  outlineLightingMix: number;
  hasOutline: boolean;
  // PBR + APBR:
  roughness: number;
  metalness: number;
  envMapIntensity: number;
  // APBR-only:
  specularIntensity: number;
  specularColor: string;
  clearcoat: number;
  clearcoatRoughness: number;
  sheen: number;
  sheenRoughness: number;
  sheenColor: string;
  transmission: number;
  thickness: number;
  ior: number;
  attenuationColor: string;
  attenuationDistance: number;
  iridescence: number;
  iridescenceIor: number;
  anisotropy: number;
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

/** APBR (MeshPhysicalMaterial) lobe defaults — match three's own defaults so a
 *  freshly-built advanced material renders identically to standard PBR until a
 *  lobe is dialled up. */
const APBR_DEFAULTS = {
  specularIntensity: 1,
  specularColor: '#ffffff',
  clearcoat: 0,
  clearcoatRoughness: 0,
  sheen: 0,
  sheenRoughness: 1,
  sheenColor: '#000000',
  transmission: 0,
  thickness: 0,
  ior: 1.5,
  attenuationColor: '#ffffff',
  attenuationDistance: 0, // 0 == disabled (mapped to Infinity on apply)
  iridescence: 0,
  iridescenceIor: 1.3,
  anisotropy: 0,
} as const;

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
  /** Cached per-vertex normal arrays for the smoothing blend, built lazily. */
  normalCache: { original: Float32Array; smooth: Float32Array } | null;
}

interface Slot {
  key: MaterialKey;
  displayName: string;
  nativeShader: ShaderKind;
  /** The original authored material (never disposed by us). */
  source: THREE.Material;
  /** The authored emissive texture, cached so we can swap/detach it per the
   *  emissive-map mode and restore it. */
  sourceEmissiveMap: THREE.Texture | null;
  /** The authored base-color (albedo) texture, for the `albedo` emissive mode. */
  sourceMap: THREE.Texture | null;
  defaults: MaterialDefaults;
  meshes: MeshSlot[];
  /** Lazily built standard-PBR material; cached for reuse across switches. */
  pbr: THREE.MeshStandardMaterial | null;
  /** Lazily built advanced-PBR (physical) material; cached for reuse. */
  apbr: THREE.MeshPhysicalMaterial | null;
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
  flatShading?: boolean;
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
  giEqualizationFactor: number;
  matcapFactor: THREE.Color;
  parametricRimColorFactor: THREE.Color;
  rimLightingMixFactor: number;
  parametricRimFresnelPowerFactor: number;
  parametricRimLiftFactor: number;
  outlineWidthFactor: number;
  outlineColorFactor: THREE.Color;
  outlineLightingMixFactor: number;
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
    hasEmissiveMap: !!m.emissiveMap,
    normalScale: m.normalScale?.x ?? 1,
    hasNormalMap: !!m.normalMap,
    flatShading: (m as { flatShading?: boolean }).flatShading ?? false,
    doubleSided: source.side === THREE.DoubleSide,
    alphaMode: deriveAlphaMode(source),
    alphaCutoff: source.alphaTest > 0 ? source.alphaTest : DEFAULT_ALPHA_CUTOFF,
    opacity: source.opacity ?? 1,
    shadeColor: mtoon ? hex(m.shadeColorFactor) : '#808080',
    shadingShiftFactor: mtoon ? m.shadingShiftFactor : 0,
    shadingToonyFactor: mtoon ? m.shadingToonyFactor : 0.9,
    giEqualization: mtoon ? (m.giEqualizationFactor ?? 0.9) : 0.9,
    matcapColor: mtoon ? hex(m.matcapFactor) : '#000000',
    rimColor: mtoon ? hex(m.parametricRimColorFactor) : '#000000',
    rimLightingMix: mtoon ? m.rimLightingMixFactor : 1,
    rimFresnelPower: mtoon ? (m.parametricRimFresnelPowerFactor ?? 5) : 5,
    rimLift: mtoon ? (m.parametricRimLiftFactor ?? 0) : 0,
    outlineWidth: mtoon ? m.outlineWidthFactor : 0,
    outlineColor: mtoon ? hex(m.outlineColorFactor) : '#000000',
    outlineLightingMix: mtoon ? (m.outlineLightingMixFactor ?? 1) : 1,
    hasOutline: false, // patched in below once outline meshes are matched
    roughness: mtoon
      ? DEFAULT_PBR_ROUGHNESS
      : (m.roughness ?? DEFAULT_PBR_ROUGHNESS),
    metalness: mtoon
      ? DEFAULT_PBR_METALNESS
      : (m.metalness ?? DEFAULT_PBR_METALNESS),
    envMapIntensity: mtoon ? 1 : (m.envMapIntensity ?? 1),
    ...APBR_DEFAULTS,
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
      sourceEmissiveMap:
        (mat as Partial<THREE.MeshStandardMaterial>).emissiveMap ?? null,
      sourceMap: (mat as Partial<THREE.MeshStandardMaterial>).map ?? null,
      defaults: readDefaults(mat),
      meshes: [],
      pbr: null,
      apbr: null,
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
        normalCache: null,
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
  cutoff: number,
  opacity: number
): boolean {
  // Opacity < 1 must force transparent on, else the value is ignored (and MToon
  // forces alpha to 1 via its OPAQUE define).
  const transparent = mode === 'blend' || opacity < 1;
  const alphaTest = mode === 'mask' ? cutoff : 0;
  let changed = false;
  if (mat.transparent !== transparent) {
    mat.transparent = transparent;
    changed = true;
  }
  if (mat.alphaTest !== alphaTest) {
    mat.alphaTest = alphaTest;
    changed = true;
  }
  mat.opacity = opacity; // uniform/value change — no recompile needed
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

function applyFlatShading(
  mat: { flatShading?: boolean },
  on: boolean
): boolean {
  if (!!mat.flatShading !== on) {
    mat.flatShading = on;
    return true;
  }
  return false;
}

/** Blend a mesh's authored vertex normals toward fully-smoothed normals.
 *  `t` in [0,1]: 0 = authored, 1 = `computeVertexNormals()` (area-averaged).
 *  Only the base `normal` attribute is rewritten — topology, skinning and morph
 *  targets are untouched. Caches the authored + smoothed arrays on first use. */
function applyNormalSmoothing(ms: MeshSlot, t: number): void {
  const geo = ms.mesh.geometry as THREE.BufferGeometry;
  const nAttr = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (!nAttr) return;
  const k = Math.max(0, Math.min(1, t));
  // Never touched and no smoothing requested → leave authored normals as-is.
  if (k === 0 && !ms.normalCache) return;
  if (!ms.normalCache) {
    const original = Float32Array.from(nAttr.array as ArrayLike<number>);
    geo.computeVertexNormals(); // mutates `normal` in place → smoothed
    const smoothAttr = geo.getAttribute('normal') as THREE.BufferAttribute;
    const smooth = Float32Array.from(smoothAttr.array as ArrayLike<number>);
    ms.normalCache = { original, smooth };
  }
  const { original, smooth } = ms.normalCache;
  const arr = nAttr.array as Float32Array;
  for (let i = 0; i < arr.length; i += 3) {
    const x = original[i] + (smooth[i] - original[i]) * k;
    const y = original[i + 1] + (smooth[i + 1] - original[i + 1]) * k;
    const z = original[i + 2] + (smooth[i + 2] - original[i + 2]) * k;
    const len = Math.hypot(x, y, z) || 1;
    arr[i] = x / len;
    arr[i + 1] = y / len;
    arr[i + 2] = z / len;
  }
  nAttr.needsUpdate = true;
}

/** Pick the emissive texture per the emissive-map mode. glTF/MToon multiply the
 *  emissive factor by this texture, so `flat` (none) lets the emissive color
 *  show everywhere and `albedo` makes the material emit its own diffuse pattern.
 *  Returns true when the binding changed (may toggle USE_EMISSIVEMAP → recompile). */
function applyEmissiveMap(
  mat: { emissiveMap: THREE.Texture | null },
  slot: Slot,
  ov: MaterialOverride | undefined
): boolean {
  const mode = ov?.emissiveMapMode ?? 'original';
  const next =
    mode === 'flat'
      ? null
      : mode === 'albedo'
        ? slot.sourceMap
        : slot.sourceEmissiveMap;
  if (mat.emissiveMap !== next) {
    mat.emissiveMap = next;
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
  m.giEqualizationFactor = ov?.giEqualization ?? d.giEqualization;
  m.matcapFactor.set(ov?.matcapColor ?? d.matcapColor);
  m.parametricRimColorFactor.set(ov?.rimColor ?? d.rimColor);
  m.rimLightingMixFactor = ov?.rimLightingMix ?? d.rimLightingMix;
  m.parametricRimFresnelPowerFactor = ov?.rimFresnelPower ?? d.rimFresnelPower;
  m.parametricRimLiftFactor = ov?.rimLift ?? d.rimLift;

  let recompile = false;
  recompile = applySide(m, ov?.doubleSided ?? d.doubleSided) || recompile;
  recompile =
    applyAlpha(
      m,
      ov?.alphaMode ?? d.alphaMode,
      ov?.alphaCutoff ?? d.alphaCutoff,
      ov?.opacity ?? d.opacity
    ) || recompile;
  recompile = applyEmissiveMap(m, slot, ov) || recompile;
  recompile =
    applyFlatShading(m, ov?.flatShading ?? d.flatShading) || recompile;
  if (recompile) m.needsUpdate = true;

  // Restore the surface material reference + outline params on each mesh.
  const width = ov?.outlineWidth ?? d.outlineWidth;
  const outlineColor = ov?.outlineColor ?? d.outlineColor;
  const outlineMix = ov?.outlineLightingMix ?? d.outlineLightingMix;
  for (const ms of slot.meshes) {
    if (ms.isArray) {
      (ms.mesh.material as THREE.Material[])[ms.surfaceIndex] = slot.source;
    } else {
      ms.mesh.material = slot.source;
    }
    if (ms.outlineMat) {
      ms.outlineMat.outlineWidthFactor = width;
      ms.outlineMat.outlineColorFactor.set(outlineColor);
      ms.outlineMat.outlineLightingMixFactor = outlineMix;
    }
  }
  slot.current = 'mtoon';
}

/** Carry the authored base maps + render flags onto a standard/physical target.
 *  Uses explicit field copies (not `Material.copy`) so it's safe across material
 *  types — copying a non-physical source into a MeshPhysicalMaterial via `.copy`
 *  would clobber its `defines` / read undefined physical-only fields. Roughness
 *  and metalness are seeded to defaults here and then re-derived per authored
 *  value in {@link applyStandardCommon}. */
function populateStandardFrom(
  target: THREE.MeshStandardMaterial,
  source: THREE.Material
): void {
  const s = source as Partial<THREE.MeshStandardMaterial> & THREE.Material;
  if (s.map) target.map = s.map;
  if (s.color) target.color.copy(s.color);
  if (s.normalMap) target.normalMap = s.normalMap;
  if (s.normalScale) target.normalScale.copy(s.normalScale);
  if (s.emissive) target.emissive.copy(s.emissive);
  if (s.emissiveMap) target.emissiveMap = s.emissiveMap;
  if (typeof s.emissiveIntensity === 'number')
    target.emissiveIntensity = s.emissiveIntensity;
  // Extra PBR maps — present on native MeshStandardMaterial sources, absent on MToon.
  if (s.aoMap) {
    target.aoMap = s.aoMap;
    target.aoMapIntensity = s.aoMapIntensity ?? 1;
  }
  if (s.roughnessMap) target.roughnessMap = s.roughnessMap;
  if (s.metalnessMap) target.metalnessMap = s.metalnessMap;

  target.transparent = source.transparent;
  target.opacity = source.opacity;
  target.alphaTest = source.alphaTest;
  target.depthWrite = source.depthWrite;
  target.side = source.side;
  target.toneMapped = source.toneMapped;
  target.roughness = DEFAULT_PBR_ROUGHNESS;
  target.metalness = DEFAULT_PBR_METALNESS;
}

function buildStandard(source: THREE.Material): THREE.MeshStandardMaterial {
  const std = new THREE.MeshStandardMaterial();
  std.name = `${source.name || 'material'} (PBR)`;
  populateStandardFrom(std, source);
  return std;
}

function buildPhysical(source: THREE.Material): THREE.MeshPhysicalMaterial {
  const phys = new THREE.MeshPhysicalMaterial();
  phys.name = `${source.name || 'material'} (APBR)`;
  populateStandardFrom(phys, source);
  return phys;
}

/** Apply the params shared by standard + physical materials. */
function applyStandardCommon(
  p: THREE.MeshStandardMaterial,
  ov: MaterialOverride | undefined,
  d: MaterialDefaults,
  slot: Slot
): void {
  p.color.set(ov?.baseColor ?? d.baseColor);
  p.emissive.set(ov?.emissive ?? d.emissive);
  p.emissiveIntensity = ov?.emissiveIntensity ?? d.emissiveIntensity;
  if (p.normalMap) {
    const ns = ov?.normalScale ?? d.normalScale;
    p.normalScale.set(ns, ns);
  }
  p.roughness = ov?.roughness ?? d.roughness;
  p.metalness = ov?.metalness ?? d.metalness;
  p.envMapIntensity = ov?.envMapIntensity ?? d.envMapIntensity;

  let recompile = false;
  recompile = applySide(p, ov?.doubleSided ?? d.doubleSided) || recompile;
  recompile =
    applyAlpha(
      p,
      ov?.alphaMode ?? d.alphaMode,
      ov?.alphaCutoff ?? d.alphaCutoff,
      ov?.opacity ?? d.opacity
    ) || recompile;
  recompile = applyEmissiveMap(p, slot, ov) || recompile;
  recompile =
    applyFlatShading(p, ov?.flatShading ?? d.flatShading) || recompile;
  if (recompile) p.needsUpdate = true;
}

/** Apply the advanced MeshPhysicalMaterial lobes. */
function applyAdvanced(
  p: THREE.MeshPhysicalMaterial,
  ov: MaterialOverride | undefined,
  d: MaterialDefaults
): void {
  p.specularIntensity = ov?.specularIntensity ?? d.specularIntensity;
  p.specularColor.set(ov?.specularColor ?? d.specularColor);
  p.clearcoat = ov?.clearcoat ?? d.clearcoat;
  p.clearcoatRoughness = ov?.clearcoatRoughness ?? d.clearcoatRoughness;
  p.sheen = ov?.sheen ?? d.sheen;
  p.sheenRoughness = ov?.sheenRoughness ?? d.sheenRoughness;
  p.sheenColor.set(ov?.sheenColor ?? d.sheenColor);
  p.transmission = ov?.transmission ?? d.transmission;
  p.thickness = ov?.thickness ?? d.thickness;
  p.ior = ov?.ior ?? d.ior;
  p.attenuationColor.set(ov?.attenuationColor ?? d.attenuationColor);
  const attDist = ov?.attenuationDistance ?? d.attenuationDistance;
  p.attenuationDistance = attDist > 0 ? attDist : Infinity;
  p.iridescence = ov?.iridescence ?? d.iridescence;
  p.iridescenceIOR = ov?.iridescenceIor ?? d.iridescenceIor;
  p.anisotropy = ov?.anisotropy ?? d.anisotropy;
}

/** Build (lazily) + apply a standard or physical material, then swap it onto
 *  every mesh slot and collapse the toon outline. */
function applyStandardLike(
  slot: Slot,
  ov: MaterialOverride | undefined,
  mode: 'pbr' | 'apbr'
): void {
  const d = slot.defaults;
  let p: THREE.MeshStandardMaterial;
  if (mode === 'apbr') {
    if (!slot.apbr) slot.apbr = buildPhysical(slot.source);
    applyStandardCommon(slot.apbr, ov, d, slot);
    applyAdvanced(slot.apbr, ov, d);
    p = slot.apbr;
  } else {
    if (!slot.pbr) slot.pbr = buildStandard(slot.source);
    applyStandardCommon(slot.pbr, ov, d, slot);
    p = slot.pbr;
  }

  for (const ms of slot.meshes) {
    if (ms.isArray) {
      (ms.mesh.material as THREE.Material[])[ms.surfaceIndex] = p;
    } else {
      ms.mesh.material = p;
    }
    if (ms.outlineMat) ms.outlineMat.outlineWidthFactor = 0;
  }
  slot.current = mode;
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
    let shader: ShaderKind = ov?.shader ?? slot.nativeShader;
    // Native-PBR materials can't become MToon (no MToon source to restore).
    if (shader === 'mtoon' && !isMToon(slot.source)) shader = 'pbr';
    if (shader === 'apbr') applyStandardLike(slot, ov, 'apbr');
    else if (shader === 'pbr') applyStandardLike(slot, ov, 'pbr');
    else applyMToon(slot, ov);
    // Per-mesh geometry tweak — independent of the active shader material.
    for (const ms of slot.meshes)
      applyNormalSmoothing(ms, ov?.normalSmoothing ?? 0);
  }
}

/** Dispose the PBR/APBR materials we created for this VRM. Call on VRM unload. */
export function disposeMaterialOverrides(vrm: VRM): void {
  const reg = registries.get(vrm);
  if (!reg) return;
  for (const slot of reg.slots.values()) {
    slot.pbr?.dispose();
    slot.pbr = null;
    slot.apbr?.dispose();
    slot.apbr = null;
  }
  registries.delete(vrm);
}
