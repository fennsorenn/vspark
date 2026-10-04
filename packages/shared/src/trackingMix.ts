/**
 * Tracking Mix — how strongly each pose/expression source drives each bone and
 * blendshape of an avatar.
 *
 * Several sources can drive one avatar at once: the animation layer (clips, in
 * the frontend) and any number of tracking behaviors (VMC, iFacialMocap,
 * MediaPipe, Breathing, Lipsync, …) composed by the backend broadcast bus. The
 * mix stores one weight per (source, bone) and per (source, blendshape) on the
 * avatar node as `properties.trackingMix`; anything absent is weight 1, so an
 * avatar without a mix composes exactly as before the mix existed.
 *
 * Composition (bus): each tracking source contributes its rotation scaled
 * toward identity by its weight (`scaleRotation`), multiplied in `order`.
 * Weights are NOT normalised — weights summing to 1 approximate a blend, and a
 * sum above 1 stacks (e.g. Breathing on top of full tracking). Blendshapes sum
 * `weight × value`. Animation weights are applied in the frontend, under all
 * tracking.
 *
 * Regions (bones) and groups (blendshapes) exist only in the UI: a region
 * slider writes every bone of the region, so the stored data stays flat.
 *
 * Pure and dependency-light so the bus, the Viewport and the editor share it.
 */

import { Quaternion, VRM_BONE_NAMES } from './signal.js';
import type { VRMBoneName } from './signal.js';
import type { TrackingMix, TrackingMixSource } from './types.js';

export type { TrackingMix, TrackingMixSource } from './types.js';

/** Reserved source key for the animation layer (applied in the frontend). */
export const ANIMATION_SOURCE = 'animation';

/** Per-cell weight range. Above 1 amplifies a weak source. */
export const MIX_WEIGHT_MIN = 0;
export const MIX_WEIGHT_MAX = 2;

/** Behavior kinds that publish bones to the bus (tracking-mix Body columns). */
export const BONE_SOURCE_KINDS = [
  'vmc_receiver',
  'ifacialmocap_receiver',
  'mediapipe_tracker',
  'breathing',
] as const;

/** Behavior kinds that publish blendshapes to the bus (Face columns). */
export const BLENDSHAPE_SOURCE_KINDS = [
  'vmc_receiver',
  'ifacialmocap_receiver',
  'mediapipe_tracker',
  'lipsync',
  'api_controller',
] as const;

// ── Body regions ─────────────────────────────────────────────────────────────

export type MixRegion = 'head' | 'gaze' | 'body' | 'arms' | 'hands' | 'legs';

/** Display order of the body regions. */
export const MIX_REGIONS: readonly MixRegion[] = [
  'head',
  'gaze',
  'body',
  'arms',
  'hands',
  'legs',
];

const EXPLICIT_REGION_BONES: Record<
  Exclude<MixRegion, 'hands'>,
  VRMBoneName[]
> = {
  body: ['spine', 'chest', 'upperChest'],
  head: ['neck', 'head', 'jaw'],
  gaze: ['leftEye', 'rightEye'],
  arms: [
    'leftShoulder',
    'leftUpperArm',
    'leftLowerArm',
    'leftHand',
    'rightShoulder',
    'rightUpperArm',
    'rightLowerArm',
    'rightHand',
  ],
  // The hips lead the lower body: their rotation and their root position both
  // follow the legs region.
  legs: [
    'hips',
    'leftUpperLeg',
    'leftLowerLeg',
    'leftFoot',
    'leftToes',
    'rightUpperLeg',
    'rightLowerLeg',
    'rightFoot',
    'rightToes',
  ],
};

/** region → its bones, in VRM_BONE_NAMES order. Every bone not listed
 *  explicitly (all finger bones) belongs to `hands`. */
export const MIX_REGION_BONES: Readonly<
  Record<MixRegion, readonly VRMBoneName[]>
> = (() => {
  const out = { hands: [] as VRMBoneName[] } as Record<
    MixRegion,
    VRMBoneName[]
  >;
  for (const r of Object.keys(EXPLICIT_REGION_BONES) as Exclude<
    MixRegion,
    'hands'
  >[])
    out[r] = [];
  const lookup = new Map<string, MixRegion>();
  for (const [r, bones] of Object.entries(EXPLICIT_REGION_BONES))
    for (const b of bones) lookup.set(b, r as MixRegion);
  for (const b of VRM_BONE_NAMES) out[lookup.get(b) ?? 'hands'].push(b);
  return out;
})();

const BONE_REGION = new Map<string, MixRegion>();
for (const r of MIX_REGIONS)
  for (const b of MIX_REGION_BONES[r]) BONE_REGION.set(b, r);

/** The body region a bone belongs to (unknown names fall under `hands`). */
export function boneRegion(bone: string): MixRegion {
  return BONE_REGION.get(bone) ?? 'hands';
}

// ── Face groups ──────────────────────────────────────────────────────────────

export type MixFaceGroup = 'mouth' | 'eyes' | 'brows' | 'emotions' | 'other';

export const MIX_FACE_GROUPS: readonly MixFaceGroup[] = [
  'mouth',
  'eyes',
  'brows',
  'emotions',
  'other',
];

const EMOTION_NAMES = new Set([
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
  'neutral',
  'joy',
  'sorrow',
  'fun',
]);
const MOUTH_PRESETS = new Set([
  'aa',
  'ih',
  'ou',
  'ee',
  'oh',
  'a',
  'i',
  'u',
  'e',
  'o',
]);
const EYE_PRESETS = new Set([
  'blink',
  'blinkleft',
  'blinkright',
  'blink_l',
  'blink_r',
  'lookup',
  'lookdown',
  'lookleft',
  'lookright',
]);

/**
 * Group a blendshape name for the Face tab. Covers VRoid morph targets
 * (`Fcl_MTH_A`, `Fcl_EYE_Close`, `Fcl_BRW_Angry`, `Fcl_ALL_Joy`, `Fcl_HA_*`
 * teeth), VRM 0.x / 1.0 presets (`A`, `aa`, `Blink`, `happy`, …) and ARKit
 * passthrough names (`jawOpen`, `eyeBlinkLeft`, `browInnerUp`, …).
 */
export function faceGroupOf(name: string): MixFaceGroup {
  const n = name.toLowerCase();
  if (n.startsWith('fcl_mth_') || n.startsWith('fcl_ha_')) return 'mouth';
  if (n.startsWith('fcl_eye_')) return 'eyes';
  if (n.startsWith('fcl_brw_')) return 'brows';
  if (n.startsWith('fcl_all_')) return 'emotions';
  if (EMOTION_NAMES.has(n)) return 'emotions';
  if (MOUTH_PRESETS.has(n)) return 'mouth';
  if (EYE_PRESETS.has(n)) return 'eyes';
  if (
    n.startsWith('mouth') ||
    n.startsWith('jaw') ||
    n.startsWith('tongue') ||
    n.startsWith('viseme')
  )
    return 'mouth';
  if (n.startsWith('eye')) return 'eyes';
  if (n.startsWith('brow')) return 'brows';
  return 'other';
}

// ── Lookups ──────────────────────────────────────────────────────────────────

/** Clamp a weight into the allowed range; non-finite → 1. */
export function clampMixWeight(w: unknown): number {
  if (typeof w !== 'number' || !Number.isFinite(w)) return 1;
  return Math.max(MIX_WEIGHT_MIN, Math.min(MIX_WEIGHT_MAX, w));
}

/** Weight of `source` on `bone` (absent → 1). */
export function boneWeight(
  mix: TrackingMix | undefined,
  source: string,
  bone: string
): number {
  const v = mix?.sources?.[source]?.bones?.[bone as VRMBoneName];
  return v === undefined ? 1 : clampMixWeight(v);
}

/** Weight of `source` on blendshape `shape` (absent → 1). */
export function blendshapeWeight(
  mix: TrackingMix | undefined,
  source: string,
  shape: string
): number {
  const v = mix?.sources?.[source]?.blendshapes?.[shape];
  return v === undefined ? 1 : clampMixWeight(v);
}

/**
 * Order the tracking sources for composition. Sources listed in `mix.order`
 * come first, in that order; the rest follow by ascending legacy `priority`
 * (stable, so ties keep their arrival order). Unknown ids in `mix.order` are
 * ignored. The animation key is never part of the order — animation is the
 * base layer, applied in the frontend underneath all tracking.
 */
export function orderSources<T extends { id: string; priority: number }>(
  mix: TrackingMix | undefined,
  sources: readonly T[]
): T[] {
  const order = mix?.order ?? [];
  const rank = new Map<string, number>();
  order.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  const listed = sources
    .filter((s) => rank.has(s.id))
    .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const rest = sources
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !rank.has(s.id))
    .sort((a, b) => a.s.priority - b.s.priority || a.i - b.i)
    .map(({ s }) => s);
  return [...listed, ...rest];
}

/**
 * `q` raised to the power `w`: the same rotation axis, `w` times the angle,
 * along the shortest arc. `w = 0` → identity, `w = 1` → `q`, `w > 1`
 * extrapolates (amplifies). The tracking-mix weight of one source on one bone.
 */
export function scaleRotation(q: Quaternion, w: number): Quaternion {
  if (w === 1) return q;
  if (w === 0) return Quaternion.IDENTITY;
  let { x, y, z, w: qw } = q.normalize();
  if (qw < 0) {
    x = -x;
    y = -y;
    z = -z;
    qw = -qw;
  }
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-9) return Quaternion.IDENTITY;
  const half = Math.atan2(s, qw) * w;
  const k = Math.sin(half) / s;
  return new Quaternion(x * k, y * k, z * k, Math.cos(half));
}

// ── Editing helpers (UI) ─────────────────────────────────────────────────────

/** All values equal → that value; otherwise `null` ("Custom"). Empty → 1. */
export function uniformValue(values: readonly number[]): number | null {
  if (values.length === 0) return 1;
  const first = values[0];
  for (const v of values) if (Math.abs(v - first) > 1e-6) return null;
  return first;
}

/**
 * The value a "Custom" region/group/source resets to: the most frequent value
 * among its members; ties go to the higher value; when no value occurs more
 * than once, 1. (Decided by the user, 2026-10-05.)
 */
export function resetValueFor(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) {
    const key = Math.round(v * 1e6) / 1e6;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 1;
  for (const [v, c] of counts) {
    if (
      c > bestCount ||
      (c === bestCount && c > 1 && best !== null && v > best)
    ) {
      best = v;
      bestCount = c;
    }
  }
  return best ?? 1;
}

/** Drop weights at the default 1, empty sources and an empty order, so only
 *  deviations are stored. Returns `undefined` when nothing is left. */
export function pruneMix(
  mix: TrackingMix | undefined
): TrackingMix | undefined {
  if (!mix) return undefined;
  const sources: Record<string, TrackingMixSource> = {};
  for (const [id, src] of Object.entries(mix.sources ?? {})) {
    const bones: Partial<Record<VRMBoneName, number>> = {};
    for (const [b, v] of Object.entries(src.bones ?? {}))
      if (v !== undefined && Math.abs(v - 1) > 1e-6)
        bones[b as VRMBoneName] = clampMixWeight(v);
    const blendshapes: Record<string, number> = {};
    for (const [s, v] of Object.entries(src.blendshapes ?? {}))
      if (Math.abs(v - 1) > 1e-6) blendshapes[s] = clampMixWeight(v);
    const out: TrackingMixSource = {};
    if (Object.keys(bones).length) out.bones = bones;
    if (Object.keys(blendshapes).length) out.blendshapes = blendshapes;
    if (out.bones || out.blendshapes) sources[id] = out;
  }
  const order = (mix.order ?? []).filter((id) => id !== ANIMATION_SOURCE);
  const result: TrackingMix = {};
  if (order.length) result.order = order;
  if (Object.keys(sources).length) result.sources = sources;
  return result.order || result.sources ? result : undefined;
}

/** Set `source`'s weight on every bone in `bones`. Returns a new mix. */
export function setBoneWeights(
  mix: TrackingMix | undefined,
  source: string,
  bones: readonly string[],
  value: number
): TrackingMix {
  const src = mix?.sources?.[source] ?? {};
  const nextBones = { ...(src.bones ?? {}) } as Record<string, number>;
  const v = clampMixWeight(value);
  for (const b of bones) nextBones[b] = v;
  return {
    ...mix,
    sources: {
      ...(mix?.sources ?? {}),
      [source]: { ...src, bones: nextBones as TrackingMixSource['bones'] },
    },
  };
}

/** Set `source`'s weight on every blendshape in `shapes`. Returns a new mix. */
export function setBlendshapeWeights(
  mix: TrackingMix | undefined,
  source: string,
  shapes: readonly string[],
  value: number
): TrackingMix {
  const src = mix?.sources?.[source] ?? {};
  const next = { ...(src.blendshapes ?? {}) };
  const v = clampMixWeight(value);
  for (const s of shapes) next[s] = v;
  return {
    ...mix,
    sources: {
      ...(mix?.sources ?? {}),
      [source]: { ...src, blendshapes: next },
    },
  };
}

/** Drop sources whose ids are no longer present (deleted behaviors). The
 *  animation key always survives. */
export function pruneStaleSources(
  mix: TrackingMix | undefined,
  liveIds: ReadonlySet<string>
): TrackingMix | undefined {
  if (!mix) return mix;
  const keep = (id: string) => id === ANIMATION_SOURCE || liveIds.has(id);
  const sources = Object.fromEntries(
    Object.entries(mix.sources ?? {}).filter(([id]) => keep(id))
  );
  return {
    ...mix,
    order: (mix.order ?? []).filter((id) => liveIds.has(id)),
    sources,
  };
}
