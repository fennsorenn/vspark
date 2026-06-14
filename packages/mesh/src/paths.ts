/**
 * Dotted-path helpers for the mesh replica.
 *
 * Paths address values inside a document ('' = the whole document,
 * 'transform.position.x' = a nested leaf). Objects are treated as branches;
 * arrays, scalars, null and class instances are leaves — per-index LWW on
 * arrays across peers is chaos, list ordering belongs in the data model
 * (fractional indices), not the path system.
 */

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Read the value at `path` ('' returns `obj` itself). */
export function getPath(obj: unknown, path: string): unknown {
  if (path === '') return obj;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Immutably set `path` to `value`, copying only the spine. '' replaces the
 *  whole object. Missing intermediate branches are created as plain objects. */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  if (path === '') return value as T;
  const segs = path.split('.');
  const root: Record<string, unknown> = isPlainObject(obj)
    ? { ...obj }
    : {};
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = cur[segs[i]];
    cur[segs[i]] = isPlainObject(next) ? { ...next } : {};
    cur = cur[segs[i]] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = value;
  return root as T;
}

/** Flatten a partial into [path, leafValue] pairs. Plain objects recurse;
 *  everything else (arrays, scalars, null, class instances) is a leaf. An
 *  empty plain object is a leaf (it sets `{}`). */
export function flattenToLeaves(
  value: unknown,
  prefix = ''
): [string, unknown][] {
  if (!isPlainObject(value) || Object.keys(value).length === 0)
    return [[prefix, value]];
  const out: [string, unknown][] = [];
  for (const [k, v] of Object.entries(value)) {
    const p = prefix === '' ? k : `${prefix}.${k}`;
    out.push(...flattenToLeaves(v, p));
  }
  return out;
}

/** Is `a` at or above `b` in the path hierarchy? ('' covers everything.) */
export function pathAtOrAbove(a: string, b: string): boolean {
  return a === '' || a === b || b.startsWith(a + '.');
}

/** Structural deep equality over JSON-ish values (objects, arrays, scalars). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object')
    return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k]
    )
  );
}
