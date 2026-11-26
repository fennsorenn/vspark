import { statSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/index.js';
import { getMeshCollection } from '../mesh/index.js';
import { readGlbJson } from './skeleton.js';

// ──────────────────────────────────────────────────────────────────────────────
// A VRM model's eye range ("look-at range maps"), read from the glTF JSON.
//
// A VRM declares how far its eye bones may turn in each direction: VRM 1.0 as
// `VRMC_vrm.lookAt.rangeMap*.outputScale`, VRM 0.x as
// `VRM.firstPerson.lookAt*.yRange` (degrees, for bone-type look-at). The eye
// range mapping (signal/nodes/eye_range_map.ts) scales tracked eye rotations
// into these ranges, so raw physical eye angles don't roll the iris under the
// lids. Read on the backend because the mapping runs per tracking source,
// before the bus merges sources — and must work with no editor tab open.
// ──────────────────────────────────────────────────────────────────────────────

/** Maximum eye-bone rotation (degrees) per direction. */
export interface EyeRanges {
  /** `bone` drives eye bones; `expression` drives look* expressions. */
  type: 'bone' | 'expression';
  horizontalInner: number;
  horizontalOuter: number;
  verticalDown: number;
  verticalUp: number;
}

/** three-vrm's default when a model declares nothing (rangeMap outputScale). */
export const DEFAULT_EYE_RANGES: EyeRanges = {
  type: 'bone',
  horizontalInner: 10,
  horizontalOuter: 10,
  verticalDown: 10,
  verticalUp: 10,
};

interface RangeMap1 {
  inputMaxValue?: number;
  outputScale?: number;
}
interface RangeMap0 {
  xRange?: number;
  yRange?: number;
}
export interface LookAtGltf {
  extensions?: {
    VRMC_vrm?: {
      lookAt?: {
        type?: string;
        rangeMapHorizontalInner?: RangeMap1;
        rangeMapHorizontalOuter?: RangeMap1;
        rangeMapVerticalDown?: RangeMap1;
        rangeMapVerticalUp?: RangeMap1;
      };
    };
    VRM?: {
      firstPerson?: {
        lookAtTypeName?: string;
        lookAtHorizontalInner?: RangeMap0;
        lookAtHorizontalOuter?: RangeMap0;
        lookAtVerticalDown?: RangeMap0;
        lookAtVerticalUp?: RangeMap0;
      };
    };
  };
}

const deg = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;

/** Eye ranges from a VRM's glTF JSON; null when it declares no look-at. */
export function extractEyeRanges(gltf: LookAtGltf): EyeRanges | null {
  const d = DEFAULT_EYE_RANGES;
  const v1 = gltf.extensions?.VRMC_vrm?.lookAt;
  if (v1) {
    return {
      type: v1.type === 'expression' ? 'expression' : 'bone',
      horizontalInner: deg(
        v1.rangeMapHorizontalInner?.outputScale,
        d.horizontalInner
      ),
      horizontalOuter: deg(
        v1.rangeMapHorizontalOuter?.outputScale,
        d.horizontalOuter
      ),
      verticalDown: deg(v1.rangeMapVerticalDown?.outputScale, d.verticalDown),
      verticalUp: deg(v1.rangeMapVerticalUp?.outputScale, d.verticalUp),
    };
  }
  const v0 = gltf.extensions?.VRM?.firstPerson;
  if (v0) {
    return {
      type: v0.lookAtTypeName === 'BlendShape' ? 'expression' : 'bone',
      horizontalInner: deg(v0.lookAtHorizontalInner?.yRange, d.horizontalInner),
      horizontalOuter: deg(v0.lookAtHorizontalOuter?.yRange, d.horizontalOuter),
      verticalDown: deg(v0.lookAtVerticalDown?.yRange, d.verticalDown),
      verticalUp: deg(v0.lookAtVerticalUp?.yRange, d.verticalUp),
    };
  }
  return null;
}

/** Parsed ranges per absolute file path, invalidated by mtime. */
const _byFile = new Map<
  string,
  { mtimeMs: number; ranges: EyeRanges | null }
>();

function _rangesForFile(absPath: string): EyeRanges | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(absPath).mtimeMs;
  } catch {
    return null;
  }
  const hit = _byFile.get(absPath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.ranges;
  let ranges: EyeRanges | null = null;
  try {
    ranges = extractEyeRanges(readGlbJson<LookAtGltf>(absPath));
  } catch {
    ranges = null; // not a GLB / unreadable — callers fall back to defaults
  }
  _byFile.set(absPath, { mtimeMs, ranges });
  return ranges;
}

/** The model file a scene node renders (mesh doc first, DB as fallback). */
function _filePathOf(sceneNodeId: string): string | null {
  const doc = getMeshCollection('scene_node')?.get(sceneNodeId) as
    | { filePath?: string | null }
    | undefined;
  if (doc) return doc.filePath ?? null;
  const row = getDb()
    .prepare('SELECT file_path FROM scene_nodes WHERE id = ?')
    .get(sceneNodeId) as { file_path: string | null } | undefined;
  return row?.file_path ?? null;
}

/**
 * The eye ranges of the model a scene node renders, or null when the node has
 * no model, the file is missing/unreadable, or it declares no look-at. Cheap to
 * call per packet: the path comes from the in-memory mesh doc and the parse is
 * cached per file.
 */
export function eyeRangesForNode(sceneNodeId: string): EyeRanges | null {
  try {
    const filePath = _filePathOf(sceneNodeId);
    if (!filePath) return null;
    return _rangesForFile(join(process.cwd(), filePath));
  } catch {
    return null;
  }
}
