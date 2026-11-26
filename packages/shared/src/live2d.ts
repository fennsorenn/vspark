/**
 * Live2D Cubism `*.model3.json` manifest parsing + bundle completeness checking.
 *
 * A Live2D model is a *bundle*: a manifest plus the files it references by
 * relative path (`.moc3`, textures, physics, motions, expressions …). Uploading
 * only some of those files produces a model that registers fine and then renders
 * as nothing, with no explanation — so the manifest is parsed at ingestion and
 * its references are checked against the files that actually arrived.
 *
 * Pure and dependency-free (no node `path`) so it runs unchanged on the backend
 * ingestion route and in the browser.
 *
 * Key names verified against the Cubism Web Framework's `CubismModelSettingJson`
 * (`vendor/CubismWebFramework/src/cubismmodelsettingjson.ts`, 5-r.3). Note that
 * `Groups`, `HitAreas` and `Layout` are *not* file references — they describe
 * parameter ids and layout numbers — so they are deliberately not walked here.
 */

/** Which `FileReferences` entry a manifest reference came from. */
export type Live2dRefKind =
  | 'moc'
  | 'texture'
  | 'physics'
  | 'pose'
  | 'displayInfo'
  | 'expression'
  | 'motion'
  | 'motionSound'
  | 'userData';

/**
 * `Moc` and `Textures` are load-blocking: without them there is no mesh and no
 * pixels, so the model cannot render at all. Everything else is an enhancement —
 * a model with no motions still renders, standing still.
 */
const REQUIRED_KINDS: ReadonlySet<Live2dRefKind> = new Set<Live2dRefKind>([
  'moc',
  'texture',
]);

export interface Live2dFileRef {
  /** The path exactly as written in the manifest, relative to the manifest. */
  ref: string;
  /** Normalized path relative to the *bundle root* — what an upload relPath must match. */
  relPath: string;
  kind: Live2dRefKind;
  /** True when the model cannot render without this file. */
  required: boolean;
  /** Motion group or expression name, when the reference carries one. */
  label?: string;
}

export interface Live2dBundleReport {
  /** Bundle-root-relative path of the manifest the report describes. */
  manifest: string;
  /** Every file reference the manifest makes, in manifest order. */
  refs: Live2dFileRef[];
  /** Load-blocking references with no matching uploaded file. */
  missingRequired: Live2dFileRef[];
  /** Enhancement references with no matching uploaded file. */
  missingOptional: Live2dFileRef[];
  /**
   * Manifest-level problems (unparseable JSON, no `FileReferences`, no `Moc`,
   * a reference escaping the bundle). Non-empty means the manifest itself is
   * malformed, not merely incomplete — supplying files cannot fix it.
   */
  errors: string[];
}

/**
 * Normalize a bundle-relative path: collapse `//`, drop `.` segments, resolve
 * `..` against earlier segments. Returns `null` when the path is unusable as a
 * bundle entry — absolute, backslash-separated, NUL-bearing, empty, or escaping
 * the bundle root via `..`.
 *
 * This is the same rule the upload route applies to incoming relPaths, applied
 * to manifest references so a manifest can never point outside its own bundle.
 */
export function normalizeBundlePath(p: string): string | null {
  if (typeof p !== 'string' || p === '') return null;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return null;
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      // Escaping the bundle root is never legitimate for a model reference.
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length > 0 ? out.join('/') : null;
}

/** Parent directory of a bundle-relative path (`''` for a root-level file). */
function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '' : relPath.slice(0, i);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Non-empty string, or null. */
function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * Collect every file reference a `*.model3.json` makes, resolved against the
 * bundle root.
 *
 * `manifestRelPath` is the manifest's own bundle-root-relative path; references
 * inside the manifest are relative to *it*, not to the bundle root, so a
 * manifest at `Model/foo.model3.json` referencing `tex/a.png` resolves to
 * `Model/tex/a.png`.
 *
 * Duplicate references (the same file cited twice, e.g. a motion reused across
 * groups) collapse to one entry; if any occurrence is required, the entry is.
 */
export function parseLive2dManifest(
  manifestRelPath: string,
  manifestText: string
): { refs: Live2dFileRef[]; errors: string[] } {
  const errors: string[] = [];
  let root: unknown;
  try {
    root = JSON.parse(manifestText);
  } catch {
    return { refs: [], errors: ['manifest is not valid JSON'] };
  }
  if (!isRecord(root))
    return { refs: [], errors: ['manifest is not a JSON object'] };

  const fr = root.FileReferences;
  if (!isRecord(fr))
    return { refs: [], errors: ['manifest has no FileReferences block'] };

  const base = dirOf(manifestRelPath);
  const byPath = new Map<string, Live2dFileRef>();

  const add = (raw: unknown, kind: Live2dRefKind, label?: string): void => {
    const ref = str(raw);
    if (!ref) return;
    const relPath = normalizeBundlePath(base ? `${base}/${ref}` : ref);
    if (!relPath) {
      errors.push(`unsafe manifest reference: ${ref}`);
      return;
    }
    const required = REQUIRED_KINDS.has(kind);
    const existing = byPath.get(relPath);
    if (existing) {
      // Keep the first occurrence, but never downgrade required → optional.
      if (required) existing.required = true;
      return;
    }
    byPath.set(relPath, {
      ref,
      relPath,
      kind,
      required,
      ...(label ? { label } : {}),
    });
  };

  add(fr.Moc, 'moc');

  if (Array.isArray(fr.Textures)) fr.Textures.forEach((t) => add(t, 'texture'));

  add(fr.Physics, 'physics');
  add(fr.Pose, 'pose');
  // Written by Cubism Editor (`*.cdi3.json`); the framework loader ignores it,
  // but it is a real file the bundle is expected to carry.
  add(fr.DisplayInfo, 'displayInfo');
  add(fr.UserData, 'userData');

  if (Array.isArray(fr.Expressions))
    for (const e of fr.Expressions)
      if (isRecord(e)) add(e.File, 'expression', str(e.Name) ?? undefined);

  if (isRecord(fr.Motions))
    for (const [group, entries] of Object.entries(fr.Motions)) {
      if (!Array.isArray(entries)) continue;
      entries.forEach((m, i) => {
        if (!isRecord(m)) return;
        const label = `${group}[${i}]`;
        add(m.File, 'motion', label);
        // Motions may carry a voice clip alongside the curve data.
        add(m.Sound, 'motionSound', label);
      });
    }

  const refs = [...byPath.values()];
  if (!refs.some((r) => r.kind === 'moc'))
    errors.push('manifest has no FileReferences.Moc — nothing to render');
  if (!refs.some((r) => r.kind === 'texture'))
    errors.push('manifest has no FileReferences.Textures — nothing to draw');

  return { refs, errors };
}

/**
 * Check an uploaded bundle against its manifest.
 *
 * `present` is every bundle-root-relative path in the upload (the manifest
 * included). Paths are normalized on both sides before comparison, so `./a.moc3`
 * in the manifest matches an `a.moc3` upload.
 *
 * Matching is exact and case-sensitive: the alternative — guessing that a
 * root-level `texture_00.png` satisfies a `foo.2048/texture_00.png` reference —
 * silently produces a model that loads *wrong* instead of not at all.
 */
export function checkLive2dBundle(
  manifestRelPath: string,
  manifestText: string,
  present: Iterable<string>
): Live2dBundleReport {
  const { refs, errors } = parseLive2dManifest(manifestRelPath, manifestText);
  const have = new Set<string>();
  for (const p of present) {
    const n = normalizeBundlePath(p);
    if (n) have.add(n);
  }
  const missing = refs.filter((r) => !have.has(r.relPath));
  return {
    manifest: normalizeBundlePath(manifestRelPath) ?? manifestRelPath,
    refs,
    missingRequired: missing.filter((r) => r.required),
    missingOptional: missing.filter((r) => !r.required),
    errors,
  };
}

/** True when the bundle cannot render as uploaded and must be rejected. */
export function isLive2dBundleBlocked(report: Live2dBundleReport): boolean {
  return report.errors.length > 0 || report.missingRequired.length > 0;
}
