/**
 * Grant store (server side) — the `grants` table DAO + source-side admission.
 *
 * Holds this server's grants for the namespaces it owns, and answers
 * `canAccess(requester, key, need)` by evaluating the requester's grants (its
 * own + its server's + '*') against the pure grant model in `@vspark/shared/sync`.
 * The containment (descendants) axis is injected so the store stays agnostic of
 * the concrete tree. See dev-notes/plans/permissioned-sync-mesh.md.
 *
 * This generalises `multiplayer/shares.ts`; the object-share path is migrated
 * onto it in a later slice.
 */
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import {
  evaluateAccess,
  granteeCandidates,
  type Grant,
  type Right,
  type IsDescendant,
} from '@vspark/shared/sync';

interface GrantRow {
  id: string;
  grantee: string;
  entity_rtype: string;
  entity_id: string;
  include_descendants: number;
  path_prefix: string;
  can_read: number;
  can_update: number;
  can_create: number;
  can_delete: number;
}

function rowToGrant(r: GrantRow): Grant {
  return {
    grantee: r.grantee,
    entityRtype: r.entity_rtype,
    entityId: r.entity_id,
    includeDescendants: r.include_descendants === 1,
    pathPrefix: r.path_prefix,
    rights: {
      read: r.can_read === 1,
      update: r.can_update === 1,
      create: r.can_create === 1,
      delete: r.can_delete === 1,
    },
  };
}

export interface GrantInput {
  grantee: string;
  entityRtype: string;
  entityId: string;
  includeDescendants?: boolean;
  pathPrefix?: string;
  rights: Partial<Record<Right, boolean>>;
}

/** Upsert a grant (rights are replaced on conflict of the selector). */
export function addGrant(g: GrantInput): void {
  getDb()
    .prepare(
      `INSERT INTO grants
         (id, grantee, entity_rtype, entity_id, include_descendants, path_prefix,
          can_read, can_update, can_create, can_delete)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (grantee, entity_rtype, entity_id, include_descendants, path_prefix)
       DO UPDATE SET can_read=excluded.can_read, can_update=excluded.can_update,
                     can_create=excluded.can_create, can_delete=excluded.can_delete`
    )
    .run(
      randomUUID(),
      g.grantee,
      g.entityRtype,
      g.entityId,
      g.includeDescendants ? 1 : 0,
      g.pathPrefix ?? '',
      g.rights.read ? 1 : 0,
      g.rights.update ? 1 : 0,
      g.rights.create ? 1 : 0,
      g.rights.delete ? 1 : 0
    );
}

/** Revoke grants for a grantee on an entity selector (path-agnostic match on the
 *  entity; omit `pathPrefix` to drop all paths for that selector). */
export function removeGrant(
  grantee: string,
  entityRtype: string,
  entityId: string
): void {
  getDb()
    .prepare(
      'DELETE FROM grants WHERE grantee = ? AND entity_rtype = ? AND entity_id = ?'
    )
    .run(grantee, entityRtype, entityId);
}

/** All grants whose grantee covers `requester` (itself / its server / '*'). */
export function grantsForRequester(requester: string): Grant[] {
  const cands = granteeCandidates(requester);
  const placeholders = cands.map(() => '?').join(',');
  return (
    getDb()
      .prepare(`SELECT * FROM grants WHERE grantee IN (${placeholders})`)
      .all(...cands) as unknown as GrantRow[]
  ).map(rowToGrant);
}

/** Every grant this server has issued (for the "shared by me" list). */
export function listAllGrants(): Grant[] {
  return (
    getDb().prepare('SELECT * FROM grants').all() as unknown as GrantRow[]
  ).map(rowToGrant);
}

/** All grants on a specific entity (for "who is this shared with" UIs). */
export function grantsForEntity(entityRtype: string, entityId: string): Grant[] {
  return (
    getDb()
      .prepare('SELECT * FROM grants WHERE entity_rtype = ? AND entity_id = ?')
      .all(entityRtype, entityId) as unknown as GrantRow[]
  ).map(rowToGrant);
}

/** Source-side admission: may `requester` perform `need` on `key`?
 *  `isDescendant` resolves the containment (descendants) axis. */
export function canAccess(
  requester: string,
  key: string,
  need: Right,
  isDescendant: IsDescendant
): boolean {
  return evaluateAccess(grantsForRequester(requester), key, need, isDescendant);
}
