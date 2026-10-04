/**
 * Grants — the mesh's whitelist access model (principle 9).
 *
 * A grant allows one grantee a set of rights on (rtype × entity × path prefix);
 * a participant's access is the UNION of the grants that match it, and nothing
 * is reachable without one. Read grants may be field-level: a permissive prefix
 * ('') grants the whole document, a deeper one ('settings.audio') one subtree.
 *
 * Field-level reads are made safe by projecting every outgoing message through
 * the recipient's grants at ONE point (MeshPeer's egress). The pure functions
 * here compute what a recipient may see:
 *
 *  - {@link readScope}: which parts of one entity a grant set can read;
 *  - {@link projectValue}: cut a document (or a subtree at some path) down to a
 *    scope;
 *  - {@link projectOp}: the version of an op a recipient may receive, or null.
 *
 * The matching primitives (keys, path prefixes, descendant scoping) are shared
 * with the rest of the app in `@vspark/shared/sync`.
 */
import {
  grantAllows,
  granteeCandidates,
  pathCovers,
  type Grant,
  type IsDescendant,
  type Right,
  type Subscription,
} from '@vspark/shared/sync';
import { getPath, isPlainObject, pathAtOrAbove, setPath } from './paths.js';
import type { OpEnvelope } from './wire.js';

/** What a grant set can read of one entity. */
export type ReadScope =
  | { kind: 'all' }
  | { kind: 'none' }
  /** Readable path prefixes, none covering another. */
  | { kind: 'paths'; prefixes: string[] };

const ALL: ReadScope = { kind: 'all' };
const NONE: ReadScope = { kind: 'none' };

/** Does a grant's entity axis select (rtype, id)? Path and rights ignored. */
export function grantSelectsEntity(
  g: Grant,
  rtype: string,
  id: string,
  isDescendant: IsDescendant
): boolean {
  if (g.entityRtype !== '*' && g.entityRtype !== rtype) return false;
  return (
    g.entityId === '*' ||
    g.entityId === id ||
    (g.includeDescendants && isDescendant(rtype, id, g.entityId))
  );
}

/** The parts of entity (rtype, id) that `grants` can read. */
export function readScope(
  grants: Grant[],
  rtype: string,
  id: string,
  isDescendant: IsDescendant
): ReadScope {
  const prefixes: string[] = [];
  for (const g of grants) {
    if (!g.rights.read) continue;
    if (!grantSelectsEntity(g, rtype, id, isDescendant)) continue;
    if (g.pathPrefix === '') return ALL;
    prefixes.push(g.pathPrefix);
  }
  if (prefixes.length === 0) return NONE;
  // Drop duplicates and prefixes another one already covers.
  const uniq = [...new Set(prefixes)];
  const kept = uniq.filter(
    (p) => !uniq.some((q) => q !== p && pathAtOrAbove(q, p))
  );
  return { kind: 'paths', prefixes: kept };
}

/** Can a scope see anything at or below `path`? */
export function scopeTouches(scope: ReadScope, path: string): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'none') return false;
  return scope.prefixes.some(
    (p) => pathAtOrAbove(p, path) || pathAtOrAbove(path, p)
  );
}

/** Project `value` — the content found at `atPath` inside a document — down to
 *  what `scope` can read. Returns `undefined` when nothing is readable.
 *
 *  A prefix at or above `atPath` grants the whole value. Prefixes below it
 *  select subtrees of the value; a selected subtree the value doesn't contain is
 *  simply absent. */
export function projectValue(
  value: unknown,
  scope: ReadScope,
  atPath = ''
): unknown {
  if (scope.kind === 'all') return value;
  if (scope.kind === 'none') return undefined;
  if (scope.prefixes.some((p) => pathAtOrAbove(p, atPath))) return value;
  let out: unknown = undefined;
  for (const p of scope.prefixes) {
    if (!pathAtOrAbove(atPath, p)) continue;
    const rel = atPath === '' ? p : p.slice(atPath.length + 1);
    const sub = getPath(value, rel);
    if (sub === undefined) continue;
    out = setPath(isPlainObject(out) ? out : {}, rel, sub);
  }
  return out;
}

/** The version of `env` a recipient with read scope `scope` may receive, or
 *  null when it may see none of it. Removes are delivered whole to anyone who
 *  can read some part of the entity. */
export function projectOp(
  env: OpEnvelope,
  scope: ReadScope
): OpEnvelope | null {
  if (scope.kind === 'all') return env;
  if (scope.kind === 'none') return null;
  if (env.op === 'remove') return env;
  const at = env.path ?? '';
  if (!scopeTouches(scope, at)) return null;
  const data = projectValue(env.data, scope, at);
  if (data === undefined) return null;
  return data === env.data ? env : { ...env, data };
}

/** Does any read grant overlap a subscription (entity ∧ path)? A subscription
 *  is admitted on overlap; what it then receives is projected per message. */
export function grantOverlapsSubscription(
  g: Grant,
  sub: Subscription,
  isDescendant: IsDescendant
): boolean {
  if (!g.rights.read) return false;
  if (
    g.entityRtype !== '*' &&
    sub.entityRtype !== '*' &&
    g.entityRtype !== sub.entityRtype
  )
    return false;
  const entityOverlap =
    g.entityId === '*' ||
    sub.entityId === '*' ||
    g.entityId === sub.entityId ||
    (g.includeDescendants &&
      isDescendant(sub.entityRtype, sub.entityId, g.entityId)) ||
    (sub.includeDescendants &&
      isDescendant(g.entityRtype, g.entityId, sub.entityId));
  if (!entityOverlap) return false;
  return (
    pathCovers(g.pathPrefix, sub.pathPrefix) ||
    pathCovers(sub.pathPrefix, g.pathPrefix)
  );
}

/** Union check: does any grant allow `need` on `key`? */
export function allows(
  grants: Grant[],
  key: string,
  need: Right,
  isDescendant: IsDescendant
): boolean {
  return grants.some((g) => grantAllows(g, key, need, isDescendant));
}

interface GrantEntry extends Grant {
  gid: string;
}

/** The peer's grant store: whitelist entries plus a per-participant cache. */
export class GrantStore {
  private readonly entries: GrantEntry[] = [];
  private readonly cache = new Map<string, Grant[]>();
  private readonly observers: ((
    grants: (Grant & { gid: string })[]
  ) => void)[] = [];

  constructor(private readonly newId: () => string) {}

  add(g: Grant): string {
    const gid = this.newId();
    this.entries.push({ ...g, gid });
    this.changed();
    return gid;
  }

  /** Returns whether the grant existed. */
  remove(gid: string): boolean {
    const i = this.entries.findIndex((g) => g.gid === gid);
    if (i < 0) return false;
    this.entries.splice(i, 1);
    this.changed();
    return true;
  }

  list(): (Grant & { gid: string })[] {
    return [...this.entries];
  }

  /** Every grant that covers `participant` (itself, its server, or '*'). */
  for(participant: string): Grant[] {
    let hit = this.cache.get(participant);
    if (!hit) {
      const candidates = granteeCandidates(participant);
      hit = this.entries.filter((g) => candidates.includes(g.grantee));
      this.cache.set(participant, hit);
    }
    return hit;
  }

  observe(cb: (grants: (Grant & { gid: string })[]) => void): () => void {
    this.observers.push(cb);
    return () => {
      const i = this.observers.indexOf(cb);
      if (i >= 0) this.observers.splice(i, 1);
    };
  }

  private changed(): void {
    this.cache.clear();
    const list = this.list();
    for (const cb of [...this.observers]) cb(list);
  }
}
