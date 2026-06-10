/**
 * Typed containment index (permissioned-sync-mesh plan).
 *
 * A pure, transport-agnostic in-memory index over a **typed containment
 * hierarchy**: every entity declares a parent that may be a *different* type
 * (e.g. scene_node→scene_node, behaviour→scene_node, lane→track_clip). The host
 * injects a per-rtype schema (`parentField` / allowed `parentTypes` / `canBeRoot`
 * / order + scope fields); the index maintains `byId` + ordered `childrenOf` +
 * `roots` from a stream of upsert/remove ops, and exposes:
 *   - `isDescendant` — feeds the grant store's descendants axis,
 *   - `subtree` — the cross-type transitive closure (snapshots / subtree grants),
 *   - `checkStructural` — the integrity gate (parent-type / exists / acyclic) run
 *     on every inbound structural op, so a corrupt/buggy peer can't orphan a tree.
 *
 * Transport stays per-entity by id; this just *owns the index* so the grant
 * resolver, the scene tree, and snapshot gathering share one structure instead of
 * rebuilding `parentId→children` maps independently. Sibling order is a
 * fractional-index string (lexicographic), tiebroken by id.
 */

export interface ContainmentSchema {
  /** field on the entity DTO holding its parent id (e.g. 'parentId', 'nodeId'). */
  parentField: string;
  /** rtypes a parent may be (cross-type containment). */
  parentTypes: string[];
  /** may this entity have a null parent (be a root)? */
  canBeRoot: boolean;
  /** field holding the fractional order key among siblings (optional). */
  orderField?: string;
  /** field that scopes roots (e.g. 'rootSceneNodeId') (optional). */
  scopeField?: string;
}

/** Per-rtype schema lookup; `undefined` ⇒ the rtype has no containment rules. */
export type SchemaProvider = (rtype: string) => ContainmentSchema | undefined;

export interface StructuralCheck {
  ok: boolean;
  reason?: string;
}

interface IndexNode {
  rtype: string;
  id: string;
  parentId: string | null;
  order: string;
  scope: string | null;
  data: unknown;
}

const get = (data: unknown, field?: string): unknown =>
  field ? (data as Record<string, unknown>)[field] : undefined;

/** Sort comparator: fractional order key, then id (stable concurrent tiebreak). */
function byOrder(a: IndexNode, b: IndexNode): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class ContainmentIndex {
  private readonly nodes = new Map<string, IndexNode>();
  /** parentId (or null for roots) → child ids */
  private readonly children = new Map<string | null, Set<string>>();

  constructor(private readonly schema: SchemaProvider) {}

  /** Apply a create/update. Re-parents in the children map when the parent changed. */
  upsert(rtype: string, id: string, data: unknown): void {
    const s = this.schema(rtype);
    const parentId = (get(data, s?.parentField) as string | null) ?? null;
    const order = s?.orderField ? String(get(data, s.orderField) ?? '') : '';
    const scope = (get(data, s?.scopeField) as string | null) ?? null;

    const prev = this.nodes.get(id);
    if (prev && prev.parentId !== parentId)
      this.children.get(prev.parentId)?.delete(id);

    this.nodes.set(id, { rtype, id, parentId, order, scope, data });
    let set = this.children.get(parentId);
    if (!set) this.children.set(parentId, (set = new Set()));
    set.add(id);
  }

  remove(id: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    this.nodes.delete(id);
    this.children.get(n.parentId)?.delete(id);
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }
  byId(id: string): unknown | undefined {
    return this.nodes.get(id)?.data;
  }
  rtypeOf(id: string): string | undefined {
    return this.nodes.get(id)?.rtype;
  }
  parentOf(id: string): string | null | undefined {
    return this.nodes.get(id)?.parentId;
  }

  /** Direct children of `id`, ordered; optionally filtered to one rtype. */
  childrenOf(id: string, type?: string): string[] {
    return [...(this.children.get(id) ?? [])]
      .map((cid) => this.nodes.get(cid))
      .filter((n): n is IndexNode => !!n && (!type || n.rtype === type))
      .sort(byOrder)
      .map((n) => n.id);
  }

  /** Top-level entities (null parent), ordered; optionally within one scope. */
  roots(scope?: string): string[] {
    return [...(this.children.get(null) ?? [])]
      .map((id) => this.nodes.get(id))
      .filter((n): n is IndexNode => !!n && (scope === undefined || n.scope === scope))
      .sort(byOrder)
      .map((n) => n.id);
  }

  /** `id` + all descendants (cross-type transitive closure), in BFS order. */
  subtree(id: string): string[] {
    if (!this.nodes.has(id)) return [];
    const out: string[] = [];
    const queue: string[] = [id];
    while (queue.length) {
      const cur = queue.shift()!;
      out.push(cur);
      for (const c of this.childrenOf(cur)) queue.push(c);
    }
    return out;
  }

  /** Is `childId` at or below `ancestorId`? (rtype unused — containment is
   *  cross-type; the arg keeps the {@link IsDescendant} signature.) */
  isDescendant = (_rtype: string, childId: string, ancestorId: string): boolean => {
    let cur = this.nodes.get(childId)?.parentId ?? null;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === ancestorId) return true;
      seen.add(cur);
      cur = this.nodes.get(cur)?.parentId ?? null;
    }
    return false;
  };

  /** Integrity gate for an inbound create/reparent: parent-type allowed, parent
   *  exists, and no cycle. Run alongside the grant (AuthZ) check; drop on !ok. */
  checkStructural(
    rtype: string,
    id: string,
    proposedParentId: string | null
  ): StructuralCheck {
    const s = this.schema(rtype);
    if (!s) return { ok: true }; // no containment rules for this rtype
    if (proposedParentId == null)
      return s.canBeRoot
        ? { ok: true }
        : { ok: false, reason: `${rtype} requires a parent` };
    const parent = this.nodes.get(proposedParentId);
    if (!parent) return { ok: false, reason: 'parent does not exist' };
    if (!s.parentTypes.includes(parent.rtype))
      return {
        ok: false,
        reason: `parent type '${parent.rtype}' not allowed for '${rtype}'`,
      };
    if (proposedParentId === id || this.isDescendant(rtype, proposedParentId, id))
      return { ok: false, reason: 'would create a cycle' };
    return { ok: true };
  }
}
