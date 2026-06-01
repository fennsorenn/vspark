/**
 * Preset id substitution.
 *
 * Presets are portable across projects, but the entity rows we serialize
 * carry real DB ids. Anything that references one of those ids — graph
 * descriptors with literal node/clip ids in defaultConfig, layer.config
 * blobs with embedded references, properties JSON, etc. — would still
 * point at the *source* project's ids after import, where they no longer
 * exist.
 *
 * The fix: on export, walk every string-valued cell in the payload and
 * replace literal occurrences of any id we're serializing with its
 * placeholder. On import, build the reverse map (placeholder -> newly
 * minted real id) and run the inverse walk before inserting.
 *
 * Single-pass walk: works for any field without per-kind whitelist;
 * naturally covers future node kinds and config shapes.
 *
 * Placeholders are the same per-entity-kind tags the existing serializer
 * already emits in the top-level `presetId` field (e.g. `n5`, `c3`,
 * `g1`, `tc4`, `ln2`). We wrap them in a sentinel — `__preset:<tag>` —
 * when they appear inside nested JSON blobs so we can distinguish them
 * from raw user-typed strings at import time.
 *
 * See dev-notes/modules/presets.md (planned).
 */

const SENTINEL = '__preset:';

/** Build a serialize-side substituter. Pass the (realId -> placeholderTag)
 *  map collected during the normal row-emission pass. Returns a function
 *  that recursively rewrites strings inside any plain JSON-shaped value. */
export function makeExportSubstituter(
  realToPreset: ReadonlyMap<string, string>
): <T>(value: T) => T {
  if (realToPreset.size === 0) {
    return <T>(v: T): T => v;
  }
  // Build a single regex of all real ids joined by `|`. Sort longest-first
  // so a real id that happens to be a prefix of another never wins over
  // the longer match (a non-issue for UUIDs but cheap insurance and
  // necessary if non-UUID ids ever land in this map).
  const ids = Array.from(realToPreset.keys()).sort(
    (a, b) => b.length - a.length
  );
  const escaped = ids.map(escapeRegex);
  const pattern = new RegExp(escaped.join('|'), 'g');
  return <T>(value: T): T => walk(value, (s) =>
    s.replace(pattern, (m) => `${SENTINEL}${realToPreset.get(m)}`)
  ) as T;
}

/** Build an import-side substituter. Pass the (placeholderTag -> realId)
 *  map collected during the mint pass. Strings holding `__preset:<tag>`
 *  whose tag isn't in the map are left alone — they're external refs the
 *  caller may want to surface to the user. */
export function makeImportSubstituter(
  presetToReal: ReadonlyMap<string, string>
): <T>(value: T) => T {
  // Match `__preset:<tag>` where tag is one or more chars that aren't a
  // quote, brace, or whitespace. The token will only ever appear in
  // string values inside JSON we control; the pattern is conservative.
  const pattern = /__preset:([A-Za-z0-9_-]+)/g;
  return <T>(value: T): T => walk(value, (s) =>
    s.replace(pattern, (orig, tag: string) => presetToReal.get(tag) ?? orig)
  ) as T;
}

/** Collect every `__preset:<tag>` token that's still present in a value
 *  after substitution, with the JSON path at which it appears. Used by
 *  the deserializer to report unresolved external refs to the caller. */
export function collectUnresolvedPlaceholders(
  value: unknown,
  rootPath = ''
): Array<{ path: string; placeholder: string }> {
  const out: Array<{ path: string; placeholder: string }> = [];
  const pattern = /__preset:[A-Za-z0-9_-]+/g;
  const visit = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      let m: RegExpExecArray | null;
      pattern.lastIndex = 0;
      while ((m = pattern.exec(v)) !== null) {
        out.push({ path, placeholder: m[0] });
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => visit(x, `${path}[${i}]`));
      return;
    }
    if (v != null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        visit(x, path ? `${path}.${k}` : k);
      }
    }
  };
  visit(value, rootPath);
  return out;
}

// ── internals ────────────────────────────────────────────────────────────

function walk(value: unknown, mapString: (s: string) => string): unknown {
  if (typeof value === 'string') return mapString(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, mapString));
  if (value != null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, mapString);
    }
    return out;
  }
  return value;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
