/**
 * Blendshape (VRM expression) limiting — the pure rule engine.
 *
 * Face tracking, lipsync and manual expression sources all publish into the same
 * blendshape frame. Summed naively that produces exaggerated or outright broken
 * faces: a full "joy" expression already squints the eyes, so a blink stacked on
 * top collapses the eyelid geometry; a wide-open lipsync vowel on top of a joy
 * smile stretches the mouth past what the mesh was authored for.
 *
 * Two rule kinds address that:
 *
 * 1. **Exclusive groups** — a set of *members* (one member = one concept, e.g.
 *    "joy", which may be spelled several ways across VRM versions) that must not
 *    co-occur. The strongest member wins; the others are suppressed in
 *    proportion to how strong the winner is, so the transition stays smooth.
 * 2. **Clamp rules** — while a *driver* expression is active, a set of target
 *    shapes is clamped into a reduced range. The clamp ramps in with the
 *    driver's weight rather than snapping on.
 *
 * Names are matched **case-insensitively** against the shapes actually present
 * in the frame, with `*` as a wildcard. That is what lets one default config
 * cover VRM 1.0 presets (`happy`, `aa`, `blink`), VRM 0.x presets (`Joy`, `A`,
 * `Blink`) and VRoid morph targets (`Fcl_ALL_Joy`, `Fcl_MTH_A`, `Fcl_EYE_Close`)
 * without the user having to know which flavour their model uses.
 *
 * This module is pure and dependency-free so it can be unit-tested directly and
 * shared between the backend node and any frontend preview.
 */

// ──────────────────────────────────────────────────────────────────────────────
// Config types
// ──────────────────────────────────────────────────────────────────────────────

/** One concept inside an exclusive group (e.g. "joy"), possibly spelled several ways. */
export interface ExclusiveMember {
  /** Stable id, unique within the group. */
  id: string;
  /** Display label; falls back to `id` in the UI. */
  label?: string;
  /** Name patterns that all refer to this one concept. Case-insensitive, `*` wildcard. */
  patterns: string[];
}

/**
 * How the losing members of an exclusive group are handled.
 *
 * - `suppress` — losers are scaled by `1 − strength × winnerWeight`. At a full
 *   winner and `strength: 1` the losers go to 0; at a half-strength winner they
 *   are only halved, so competing expressions cross-fade instead of popping.
 * - `normalize` — nothing wins outright; if the members sum above 1 they are all
 *   scaled down until they fit (interpolated by `strength`). Useful when the
 *   expressions are meant to blend but their *total* is what breaks the face.
 */
export type ExclusiveMode = 'suppress' | 'normalize';

/** A set of expressions that must not occur together. */
export interface ExclusiveGroup {
  id: string;
  label?: string;
  /** Default `true`. */
  enabled?: boolean;
  /** Default `'suppress'`. */
  mode?: ExclusiveMode;
  /** How hard the rule bites, 0..1. Default 1. */
  strength?: number;
  members: ExclusiveMember[];
}

/** Clamps a set of shapes into a reduced range while a driver expression is active. */
export interface ClampRule {
  id: string;
  label?: string;
  /** Default `true`. */
  enabled?: boolean;
  /**
   * Driver name patterns. The driver weight is the strongest match in the frame.
   * Omitted or empty ⇒ the clamp is unconditionally active.
   */
  when?: string[];
  /** Driver weight below which the clamp does nothing. Default 0. */
  threshold?: number;
  /**
   * Default `true`: the clamp fades in between `threshold` and a full driver, so
   * it tightens as the driver grows. `false` snaps to the full clamp the moment
   * the driver passes `threshold`.
   */
  ramp?: boolean;
  /** Name patterns of the shapes to clamp. */
  targets: string[];
  /** Lower bound at full activation. Default 0 (no floor). */
  min?: number;
  /** Upper bound at full activation. Default 1 (no ceiling). */
  max?: number;
}

export interface BlendshapeLimitsConfig {
  /** Master switch. Default `true`. */
  enabled?: boolean;
  groups?: ExclusiveGroup[];
  clamps?: ClampRule[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Defaults
// ──────────────────────────────────────────────────────────────────────────────

/** Every spelling of each emotion preset we know about, across VRM 1.0 / 0.x / VRoid. */
const JOY_PATTERNS = ['happy', 'joy', 'Fcl_ALL_Joy'];

/**
 * Shipped defaults: the five emotion presets are mutually exclusive, and a full
 * joy expression holds back the eye-close and mouth-open shapes it already
 * implies. Deliberately conservative — the clamps only bite once joy is past a
 * third of its range, and they ramp rather than snap.
 */
export const DEFAULT_BLENDSHAPE_LIMITS: BlendshapeLimitsConfig = {
  enabled: true,
  groups: [
    {
      id: 'emotions',
      label: 'Emotions',
      enabled: true,
      mode: 'suppress',
      strength: 1,
      members: [
        { id: 'joy', label: 'Joy / Happy', patterns: JOY_PATTERNS },
        { id: 'angry', label: 'Angry', patterns: ['angry', 'Fcl_ALL_Angry'] },
        {
          id: 'sad',
          label: 'Sad / Sorrow',
          patterns: ['sad', 'sorrow', 'Fcl_ALL_Sorrow'],
        },
        {
          id: 'relaxed',
          label: 'Relaxed / Fun',
          patterns: ['relaxed', 'fun', 'Fcl_ALL_Fun'],
        },
        {
          id: 'surprised',
          label: 'Surprised',
          patterns: ['surprised', 'Fcl_ALL_Surprised'],
        },
      ],
    },
  ],
  clamps: [
    {
      id: 'joy-eyes',
      label: 'Joy limits eye close',
      enabled: true,
      when: JOY_PATTERNS,
      threshold: 0.3,
      ramp: true,
      targets: [
        'blink',
        'blinkLeft',
        'blinkRight',
        'Blink_L',
        'Blink_R',
        'Fcl_EYE_Close',
        'Fcl_EYE_Close_L',
        'Fcl_EYE_Close_R',
      ],
      max: 0.5,
    },
    {
      id: 'joy-mouth',
      label: 'Joy limits mouth open',
      enabled: true,
      when: JOY_PATTERNS,
      threshold: 0.3,
      ramp: true,
      targets: [
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
        'Fcl_MTH_A',
        'Fcl_MTH_I',
        'Fcl_MTH_U',
        'Fcl_MTH_E',
        'Fcl_MTH_O',
        'Fcl_MTH_Large',
        'jawOpen',
      ],
      max: 0.6,
    },
  ],
};

/** Deep clone of the shipped defaults, safe to hand to a config editor. */
export function defaultBlendshapeLimits(): BlendshapeLimitsConfig {
  return JSON.parse(
    JSON.stringify(DEFAULT_BLENDSHAPE_LIMITS)
  ) as BlendshapeLimitsConfig;
}

// ──────────────────────────────────────────────────────────────────────────────
// Name matching
// ──────────────────────────────────────────────────────────────────────────────

const _patternCache = new Map<string, RegExp>();

/** Compile a case-insensitive, fully anchored glob (`*` = any run of characters). */
function _toRegExp(pattern: string): RegExp {
  const cached = _patternCache.get(pattern);
  if (cached) return cached;
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const re = new RegExp(`^${body}$`, 'i');
  _patternCache.set(pattern, re);
  return re;
}

/** Does `name` match any of `patterns`? Case-insensitive, `*` wildcard. */
export function matchesAnyPattern(
  name: string,
  patterns: readonly string[] | undefined
): boolean {
  if (!patterns || patterns.length === 0) return false;
  for (const p of patterns) {
    if (typeof p !== 'string' || p.length === 0) continue;
    if (_toRegExp(p).test(name)) return true;
  }
  return false;
}

/** The subset of `names` matched by `patterns`, in `names` order. */
export function matchNames(
  names: readonly string[],
  patterns: readonly string[] | undefined
): string[] {
  if (!patterns || patterns.length === 0) return [];
  return names.filter((n) => matchesAnyPattern(n, patterns));
}

// ──────────────────────────────────────────────────────────────────────────────
// Rule engine
// ──────────────────────────────────────────────────────────────────────────────

function _clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function _num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Apply an exclusive group in place over `out`.
 *
 * `values` (the pre-group frame) is not consulted — groups run in declaration
 * order and each sees the previous one's result, so overlapping groups compose
 * predictably.
 */
function _applyGroup(
  group: ExclusiveGroup,
  out: Record<string, number>,
  names: readonly string[]
): void {
  if (group.enabled === false) return;
  const members = Array.isArray(group.members) ? group.members : [];
  if (members.length < 2) return;

  const strength = _clamp01(_num(group.strength, 1));
  if (strength <= 0) return;

  // Resolve each member to the shapes it owns in this frame, and its weight
  // (the strongest of those shapes — a member is "as active as" its loudest spelling).
  const resolved = members.map((m) => {
    const owned = matchNames(names, m?.patterns);
    let weight = 0;
    for (const n of owned) weight = Math.max(weight, out[n] ?? 0);
    return { owned, weight };
  });

  const active = resolved.filter((r) => r.owned.length > 0 && r.weight > 0);
  if (active.length < 2) return; // nothing is competing

  if ((group.mode ?? 'suppress') === 'normalize') {
    const total = active.reduce((sum, r) => sum + r.weight, 0);
    if (total <= 1) return;
    // Interpolate between "leave alone" and "scale so the members sum to 1".
    const scale = 1 + strength * (1 / total - 1);
    for (const r of active)
      for (const n of r.owned) out[n] = _clamp01((out[n] ?? 0) * scale);
    return;
  }

  // suppress: strongest member wins, ties broken by declaration order.
  let winner = active[0];
  for (const r of active) if (r.weight > winner.weight) winner = r;

  const factor = _clamp01(1 - strength * _clamp01(winner.weight));
  if (factor >= 1) return;
  for (const r of active) {
    if (r === winner) continue;
    for (const n of r.owned) out[n] = _clamp01((out[n] ?? 0) * factor);
  }
}

/** How strongly a clamp rule bites right now, 0..1. */
function _clampActivation(
  rule: ClampRule,
  out: Record<string, number>,
  names: readonly string[]
): number {
  const drivers = Array.isArray(rule.when) ? rule.when : [];
  if (drivers.length === 0) return 1; // unconditional

  let driver = 0;
  for (const n of matchNames(names, drivers))
    driver = Math.max(driver, out[n] ?? 0);

  const threshold = _clamp01(_num(rule.threshold, 0));
  if (driver <= threshold) return 0;
  if (rule.ramp === false) return 1;
  if (threshold >= 1) return driver >= 1 ? 1 : 0;
  return _clamp01((driver - threshold) / (1 - threshold));
}

function _applyClamp(
  rule: ClampRule,
  out: Record<string, number>,
  names: readonly string[]
): void {
  if (rule.enabled === false) return;
  const targets = matchNames(names, rule.targets);
  if (targets.length === 0) return;

  const activation = _clampActivation(rule, out, names);
  if (activation <= 0) return;

  // Ease from the untouched range [0, 1] into the configured range.
  const max = _clamp01(_num(rule.max, 1));
  const min = _clamp01(_num(rule.min, 0));
  const maxEff = 1 + (max - 1) * activation;
  const minEff = Math.min(min * activation, maxEff);

  for (const n of targets) {
    const v = out[n] ?? 0;
    out[n] = v < minEff ? minEff : v > maxEff ? maxEff : v;
  }
}

/**
 * Run the limit rules over a blendshape frame and return the corrected weights.
 *
 * Exclusive groups run first (in declaration order), then clamp rules — so a
 * clamp's driver reads the weight the driver *ends up with* after losing or
 * winning its group, rather than the raw incoming value.
 *
 * Only shapes present in `values` are ever touched; a rule naming a shape the
 * model doesn't drive is a silent no-op. The input is never mutated.
 */
export function applyBlendshapeLimits(
  values: Readonly<Record<string, number>>,
  config: BlendshapeLimitsConfig | null | undefined
): Record<string, number> {
  const out: Record<string, number> = { ...values };
  if (!config || config.enabled === false) return out;

  const names = Object.keys(out);
  if (names.length === 0) return out;

  for (const group of config.groups ?? []) {
    if (group) _applyGroup(group, out, names);
  }
  for (const rule of config.clamps ?? []) {
    if (rule) _applyClamp(rule, out, names);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tolerant parsing — behavior config is free-form JSON the user can hand-edit
// ──────────────────────────────────────────────────────────────────────────────

function _strArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((s): s is string => typeof s === 'string')
    : [];
}

/**
 * Coerce arbitrary parsed JSON into a `BlendshapeLimitsConfig`, dropping
 * anything malformed. Never throws — a broken hand-edited config degrades to
 * "fewer rules", never to a crashed graph.
 */
export function normalizeBlendshapeLimits(
  raw: unknown
): BlendshapeLimitsConfig {
  const src = (raw ?? {}) as Record<string, unknown>;
  const groups: ExclusiveGroup[] = [];
  const clamps: ClampRule[] = [];

  if (Array.isArray(src.groups)) {
    for (const g of src.groups as Record<string, unknown>[]) {
      if (!g || typeof g !== 'object') continue;
      const members: ExclusiveMember[] = [];
      if (Array.isArray(g.members)) {
        for (const m of g.members as Record<string, unknown>[]) {
          if (!m || typeof m !== 'object') continue;
          const patterns = _strArray(m.patterns);
          if (patterns.length === 0) continue;
          members.push({
            id: typeof m.id === 'string' ? m.id : patterns[0],
            ...(typeof m.label === 'string' ? { label: m.label } : {}),
            patterns,
          });
        }
      }
      if (members.length === 0) continue;
      groups.push({
        id: typeof g.id === 'string' ? g.id : `group-${groups.length}`,
        ...(typeof g.label === 'string' ? { label: g.label } : {}),
        ...(typeof g.enabled === 'boolean' ? { enabled: g.enabled } : {}),
        ...(g.mode === 'normalize' || g.mode === 'suppress'
          ? { mode: g.mode }
          : {}),
        ...(typeof g.strength === 'number' ? { strength: g.strength } : {}),
        members,
      });
    }
  }

  if (Array.isArray(src.clamps)) {
    for (const c of src.clamps as Record<string, unknown>[]) {
      if (!c || typeof c !== 'object') continue;
      const targets = _strArray(c.targets);
      if (targets.length === 0) continue;
      clamps.push({
        id: typeof c.id === 'string' ? c.id : `clamp-${clamps.length}`,
        ...(typeof c.label === 'string' ? { label: c.label } : {}),
        ...(typeof c.enabled === 'boolean' ? { enabled: c.enabled } : {}),
        ...(Array.isArray(c.when) ? { when: _strArray(c.when) } : {}),
        ...(typeof c.threshold === 'number' ? { threshold: c.threshold } : {}),
        ...(typeof c.ramp === 'boolean' ? { ramp: c.ramp } : {}),
        targets,
        ...(typeof c.min === 'number' ? { min: c.min } : {}),
        ...(typeof c.max === 'number' ? { max: c.max } : {}),
      });
    }
  }

  return {
    enabled: src.enabled !== false,
    groups,
    clamps,
  };
}
