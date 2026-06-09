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

/** How a resource is delivered/persisted. See the design doc's "Delivery classes".
 *
 *  `event` is retained for back-compat but **deprecated**: the live-mesh design
 *  folds events into temporal `field` state — a retained, keyed
 *  "started at timestamp X" anchor (see {@link TemporalAnchor}) that late
 *  joiners render in sync rather than a fire-and-forget command. New temporal
 *  state should use `field`. See dev-notes/plans/live-mesh.md. */
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
  /** Fan-out routing hint for `remove` ops: the deleted entity's ancestor id
   *  chain (self first, up to the tree root), captured *before* deletion so
   *  subtree-scoped subscribers can still be resolved once the row is gone.
   *  Ignored by consumers that route by key. */
  route?: string[];
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

// --- Participants -----------------------------------------------------------
//
// In the live P2P mesh a "participant" is any endpoint: a backend server or a
// browser client. Backends use their stable Ed25519 peer id; a client gets
// `${serverPeerId}#${ephemeralClientUuid}` (one per tab). The participant id is
// the HLC `origin`/`n` and the loop-suppression tag, so it must be unique per
// endpoint. See dev-notes/plans/live-mesh.md.

const CLIENT_SEP = '#';

/** Mint a per-tab client participant id under its server's peer id. */
export function makeClientParticipantId(
  serverPeerId: string,
  clientUuid: string
): string {
  return `${serverPeerId}${CLIENT_SEP}${clientUuid}`;
}

/** Whether a participant id belongs to a browser client (vs a backend server). */
export function isClientParticipant(id: string): boolean {
  return id.includes(CLIENT_SEP);
}

/** The owning server's peer id for any participant (itself if it's a server). */
export function participantServer(id: string): string {
  const i = id.indexOf(CLIENT_SEP);
  return i < 0 ? id : id.slice(0, i);
}

// --- Shared clock -----------------------------------------------------------
//
// A flat mesh has no single clock, but temporal state ("started at T") needs a
// common base. Each participant tracks a smoothed offset *per origin* from
// ping/pong over the data channel; a remote anchor is converted to local time
// with `localizeAnchor(anchorT, offset)`. This generalises the per-server
// `clockOffsetMs = serverNow − Date.now()` to per-origin offsets.

/** A retained temporal value: "this began (or was anchored) at `anchorT`, in the
 *  origin's clock". Consumers derive the current frame from
 *  `localNow − localizeAnchor(anchorT, offset[origin])`. `paused` carries a
 *  fixed position instead of a running anchor. */
export interface TemporalAnchor {
  /** wall-clock millis in the originating participant's clock */
  anchorT: number;
  /** when set, playback is held at this position (seconds) rather than running */
  pausedAtT?: number;
}

/** Estimate `offset = remoteClock − localClock` from one ping round-trip:
 *  ping sent at `localSendT`, pong (carrying the peer's `remoteT`) received at
 *  `localRecvT`. Assumes symmetric latency (remoteT sampled mid-flight). */
export function estimateClockOffset(
  localSendT: number,
  remoteT: number,
  localRecvT: number
): number {
  return remoteT - (localSendT + localRecvT) / 2;
}

/** A smoothed per-origin clock-offset tracker. `observe()` folds in a fresh
 *  round-trip estimate; `offset()` returns the current best estimate (0 until
 *  the first observation). EMA-smoothed to ride out jitter. */
export function makeOffsetTracker(alpha = 0.2): {
  observe: (localSendT: number, remoteT: number, localRecvT: number) => void;
  offset: () => number;
} {
  let off = 0;
  let seeded = false;
  return {
    observe: (s, r, e) => {
      const sample = estimateClockOffset(s, r, e);
      off = seeded ? off + alpha * (sample - off) : sample;
      seeded = true;
    },
    offset: () => off,
  };
}

/** Convert an origin-clock anchor timestamp into local-clock millis. With
 *  `offset = originClock − localClock`, the local equivalent of an origin
 *  timestamp is `anchorT − offset`. */
export function localizeAnchor(anchorT: number, offsetMs: number): number {
  return anchorT - offsetMs;
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

// --- Grants -----------------------------------------------------------------
//
// A grant is two orthogonal axes × rights, matched independently against a key
// `rtype:id:subPath`:
//   • entity selection — (rtype, id) + includeDescendants  (id/'*'; a scene is
//     just the entity whose subtree is the scene)
//   • path selection   — a dotted sub-path prefix ('' = all paths)
//   • rights ⊆ {read, update, create, delete}; read/update use the path axis,
//     create/delete are structural (entity-scoped, path-independent).
// Per-peer access is the UNION of matching grants. The owning server is the
// grant authority for its own namespaces (self-grants full RUCD); enforcement is
// source-side admission. See dev-notes/plans/permissioned-sync-mesh.md.

export type Right = 'read' | 'update' | 'create' | 'delete';

export interface Grant {
  /** peer id (server OR participant) or '*' */
  grantee: string;
  /** entity type, or '*' for any */
  entityRtype: string;
  /** entity id, or '*' for any of `entityRtype` */
  entityId: string;
  /** also covers everything below `entityId` in the containment tree */
  includeDescendants: boolean;
  /** dotted sub-path prefix; '' = all paths */
  pathPrefix: string;
  rights: { read?: boolean; update?: boolean; create?: boolean; delete?: boolean };
}

/** Resolves containment for the descendants axis (injected by the host: the
 *  scene-node tree, compose tree, …). Returns true if `childId` is at or below
 *  `ancestorId` within `rtype`. */
export type IsDescendant = (
  rtype: string,
  childId: string,
  ancestorId: string
) => boolean;

/** Does a grant's path prefix cover a key's sub-path? '' covers everything. */
export function pathCovers(prefix: string, subPath: string): boolean {
  if (prefix === '') return true;
  if (subPath === prefix) return true;
  return subPath.startsWith(prefix + '.');
}

/** Does a single grant authorize `need` on `key`? (entity ∧ path ∧ right) */
export function grantAllows(
  g: Grant,
  key: string,
  need: Right,
  isDescendant: IsDescendant
): boolean {
  if (!g.rights[need]) return false;
  const { rtype, id, subPath } = parseKey(key);
  if (g.entityRtype !== '*' && g.entityRtype !== rtype) return false;
  const entityOk =
    g.entityId === '*' ||
    g.entityId === id ||
    (g.includeDescendants && isDescendant(rtype, id, g.entityId));
  if (!entityOk) return false;
  // create/delete are structural — scoped to the entity, not a field path.
  if (need === 'create' || need === 'delete') return true;
  return pathCovers(g.pathPrefix, subPath ?? '');
}

/** Union over grants: any grant that allows ⇒ allowed. */
export function evaluateAccess(
  grants: Grant[],
  key: string,
  need: Right,
  isDescendant: IsDescendant
): boolean {
  return grants.some((g) => grantAllows(g, key, need, isDescendant));
}

/** Grantee ids that cover a requester: itself, its owning server, and '*'. */
export function granteeCandidates(requester: string): string[] {
  const server = participantServer(requester);
  return server === requester ? [requester, '*'] : [requester, server, '*'];
}

// --- Typed containment hierarchy (re-exported; see ./containment) -----------
export {
  ContainmentIndex,
  type ContainmentSchema,
  type SchemaProvider,
  type StructuralCheck,
} from './containment';
