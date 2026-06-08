/**
 * Unified state-replication layer — wire format + addressing convention.
 *
 * The single envelope every sync message uses, the four resource classes, and
 * the dotted-path addressing helpers. Domain-agnostic on purpose: this file
 * knows nothing about scene nodes, VRM, or compose layers — those live in the
 * per-app resource descriptors at the edges.
 *
 * Design: dev-notes/plans/unified-sync-layer.md
 *
 * Phasing note: `v` (hybrid logical clock) and `origin` are defined here from
 * the start but only populated in Phase 4; consumers must treat them as
 * optional until then.
 */

/** How a resource is delivered/persisted. See the design doc's "Delivery classes". */
export type ResourceClass = 'document' | 'field' | 'stream' | 'event';

/** Mutation verbs carried on the wire. Not every class uses every op:
 *  document → upsert/remove · field → patch/remove · stream → frame · event → event. */
export type SyncOp = 'upsert' | 'remove' | 'patch' | 'frame' | 'event';

/** Hybrid logical clock: wall-clock millis + tiebreak counter + origin peer.
 *  Gives a total, machine-agreed ordering without synchronized clocks.
 *  Populated in Phase 4; absent before that. */
export interface HLC {
  /** wall-clock milliseconds (best-effort) */
  t: number;
  /** monotonic tiebreak counter within the same millisecond */
  c: number;
  /** originating peer id */
  n: string;
}

/** The one message shape for all synced state. */
export interface SyncEnvelope {
  /** resource type, e.g. 'scene_node' | 'override' | 'vmc_pose' */
  rtype: string;
  op: SyncOp;
  /** routing key for selective fan-out + snapshot grouping (e.g. sceneId). */
  scope?: string;
  /** entity id, composite field key, or stream key (see addressing helpers). */
  key: string;
  /** canonical DTO / value / frame. Omitted for `remove`. */
  data?: unknown;
  /** ordering/convergence stamp (Phase 4+; omitted for streams). */
  v?: HLC;
  /** originating peer id — echo + loop suppression (Phase 4+). */
  origin?: string;
}

/** WS message kind that wraps every unified-sync envelope, so it coexists with
 *  the legacy bespoke message kinds during the migration. */
export const SYNC_MESSAGE_KIND = 'sync';

// --- Hybrid logical clock ---------------------------------------------------

/** Total order over HLC stamps: returns >0 if `a` happened after `b`, <0 before,
 *  0 if identical. Compares wall-clock, then counter, then peer id (so distinct
 *  peers never tie). */
export function compareHLC(a: HLC, b: HLC): number {
  if (a.t !== b.t) return a.t - b.t;
  if (a.c !== b.c) return a.c - b.c;
  return a.n < b.n ? -1 : a.n > b.n ? 1 : 0;
}

/** Single-node monotonic HLC source. Guarantees strictly increasing (t,c) even
 *  if the wall clock stalls or jumps backwards. Multi-peer merge (folding a
 *  remote stamp's time in) arrives with the server mesh (Phase 5). */
export function makeHlcClock(peerId: string): () => HLC {
  let lastT = 0;
  let lastC = 0;
  return () => {
    const now = Date.now();
    if (now > lastT) {
      lastT = now;
      lastC = 0;
    } else {
      lastC += 1;
    }
    return { t: lastT, c: lastC, n: peerId };
  };
}

// --- Dotted-path addressing -------------------------------------------------
//
// A value's identity is `<rtype>:<id>[:<subPath>]`. The `:` separates the
// identity (rtype + id, both dot-free — ids are UUIDs) from an optional dotted
// sub-path (a paramPath like `position.x`). Dots live ONLY inside the sub-path,
// so splitting is unambiguous. Kept a string convention, not a query engine.

/** Build an address. `subPath` is a dotted paramPath (e.g. 'position.x'). */
export function makeKey(rtype: string, id: string, subPath?: string): string {
  return subPath ? `${rtype}:${id}:${subPath}` : `${rtype}:${id}`;
}

/** Split an address back into its parts. */
export function parseKey(key: string): {
  rtype: string;
  id: string;
  subPath?: string;
} {
  const first = key.indexOf(':');
  if (first < 0) return { rtype: key, id: '' };
  const second = key.indexOf(':', first + 1);
  if (second < 0)
    return { rtype: key.slice(0, first), id: key.slice(first + 1) };
  return {
    rtype: key.slice(0, first),
    id: key.slice(first + 1, second),
    subPath: key.slice(second + 1),
  };
}

/** Prefix-subscription match: is `key` covered by `prefix`?
 *  `''` / `'**'` match everything; a trailing `.*` / `.**` / `*` is treated as
 *  "this segment and below". Plain prefixes match by exact or `prefix:`/`prefix.`
 *  boundary so `scene_node:ab` doesn't accidentally match `scene_node:abc`. */
export function keyMatches(key: string, prefix: string): boolean {
  if (prefix === '' || prefix === '*' || prefix === '**') return true;
  const base = prefix.replace(/[.:]?\*+$/, '');
  if (key === base) return true;
  return key.startsWith(base + ':') || key.startsWith(base + '.');
}
