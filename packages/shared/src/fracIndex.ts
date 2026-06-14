/**
 * String fractional indexing for sibling order (permissioned-sync-mesh plan).
 *
 * Order keys are short base-62 digit strings compared by **plain lexicographic
 * sort** — no numeric precision, no renumbering. `keyBetween(a, b)` returns a key
 * strictly between its neighbours (either may be `null` for an open end), so an
 * insert/move is O(1) and never touches surrounding siblings.
 *
 * Key length: tiny for realistic scenes (tens of siblings → a few chars). It
 * grows under two degenerate patterns — repeatedly inserting into the *same* gap,
 * and very long runs of *monotonic appends* (~0.15 char/append). If that ever
 * matters, the integer-length-prefix variant (the `fractional-indexing` library's
 * approach) keeps appends O(log n); it's a non-breaking swap since the comparator
 * stays "lexicographic string sort." This fraction-only version is ~the whole
 * thing in <60 lines, no dependency.
 *
 * Total order under concurrency = `(orderKey, originId)` — two peers inserting at
 * the same gap can generate the *same* key; the caller breaks that tie with a
 * stable id (e.g. entity id / HLC origin). Single-writer use never collides.
 *
 * Alphabet is an ASCII subset in ascending byte order, so JS `<`, SQLite `BINARY`
 * collation, and any other consumer agree on ordering. Invariant: generated keys
 * never end in the lowest digit `'0'`, which guarantees a key can always be placed
 * before/after/between existing ones. ~No dependency — this is the whole thing.~
 */

const DIGITS =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length; // 62
const di = (c: string): number => DIGITS.indexOf(c);

/** Digit string strictly between fractions `a` and `b` (base-62, as `0.<digits>`).
 *  `a === null` ⇒ lower bound 0; `b === null` ⇒ upper bound 1 ("top"). */
function midpoint(a: string | null, b: string | null): string {
  let result = '';
  let i = 0;
  let bTop = b === null;
  for (;;) {
    const ad = a !== null && i < a.length ? di(a[i]) : 0; // a padded with 0
    const bd = bTop ? BASE : b !== null && i < b.length ? di(b[i]) : 0;
    if (ad === bd) {
      // shared digit — copy and descend
      result += DIGITS[ad];
      i += 1;
      continue;
    }
    if (bd - ad > 1) {
      // room between the digits — place the middle one and stop
      return result + DIGITS[Math.floor((ad + bd) / 2)];
    }
    // adjacent digits (bd === ad + 1): keep a's digit; from here the upper bound
    // is "top", so the next non-max digit of a yields a gap to split.
    result += DIGITS[ad];
    bTop = true;
    i += 1;
  }
}

/** A key strictly between `a` and `b` (lexicographically). `null` = open end.
 *  Throws if `a >= b`. The result never ends in `'0'`. */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b)
    throw new Error(`keyBetween: keys disordered ('${a}' >= '${b}')`);
  return midpoint(a, b);
}

/** Append after the current last key (or first key in an empty list). */
export function keyAfter(last: string | null): string {
  return keyBetween(last, null);
}

/** Prepend before the current first key (or first key in an empty list). */
export function keyBefore(first: string | null): string {
  return keyBetween(null, first);
}

/** n evenly-spread keys for seeding an initial ordered list. */
export function keysBetween(
  a: string | null,
  b: string | null,
  n: number
): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  // bisect recursively so all n keys are distinct and ordered
  const mid = keyBetween(a, b);
  const left = Math.floor((n - 1) / 2);
  return [...keysBetween(a, mid, left), mid, ...keysBetween(mid, b, n - 1 - left)];
}
