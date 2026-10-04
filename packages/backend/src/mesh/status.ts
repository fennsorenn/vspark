/**
 * Server status as retained mesh documents (W2 of plans/mesh-sole-channel.md).
 *
 * The state of an outside link or a server process — an OBS connection, a
 * streaming account, a mocap receiver, the OBS output window — used to be a
 * WS broadcast plus a hand-written "send the current state to each new
 * client" handler per producer. A document on the `runtime` channel is both:
 * retained, so a tab that connects later gets the current value from its
 * subscription snapshot; volatile, so it lives exactly as long as this server
 * process, which is how long the status is true.
 *
 * One collection, `server_status`, documents keyed `${kind}:${key}`. A status
 * that is ABOUT a document (a receiver's tracking state is about its
 * behavior) declares it in `of`, which places it in the containment tree:
 * it is then visible wherever that document is, e.g. to a collab peer
 * through its scene grant. Tabs read; only this server writes.
 */
import type { Collection, MeshPeer } from '@vspark/mesh';

export const SERVER_STATUS_RTYPE = 'server_status';

/** What a status document describes. */
export type StatusKind =
  /** a mocap receiver behavior: `connected` (packets arriving) and
   *  `tracking` (a pose is being produced). Key = behavior id. */
  | 'tracking'
  /** an obs-websocket connection: status / reason / message. Key = id. */
  | 'obs_connection'
  /** a streaming account: status / reason / message. Key = account id. */
  | 'overlive_account'
  /** the OBS window-capture runtime (key 'main'). */
  | 'output_window';

export interface StatusDoc {
  id: string;
  kind: StatusKind;
  key: string;
  of?: { rtype: string; id: string } | null;
  [field: string]: unknown;
}

export const statusId = (kind: StatusKind, key: string): string =>
  `${kind}:${key}`;

let _col: Collection<StatusDoc> | null = null;

export function initServerStatus(peer: MeshPeer): void {
  if (_col) return;
  _col = peer.collection<StatusDoc>(SERVER_STATUS_RTYPE);
  peer.grants.grant({
    grantee: peer.id, // our tabs read our status; only we write it
    entityRtype: SERVER_STATUS_RTYPE,
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
    rights: { read: true },
  });
}

export function resetServerStatus(): void {
  _col = null;
}

/** Set fields of a status, keeping the ones not mentioned. No-op before the
 *  mesh is up (tests and early boot): status is advisory. */
export function publishStatus(
  kind: StatusKind,
  key: string,
  fields: Record<string, unknown>,
  of?: { rtype: string; id: string }
): void {
  if (!_col) return;
  const id = statusId(kind, key);
  const cur = _col.get(id);
  _col.set(
    id,
    '',
    { ...cur, ...fields, id, kind, key, of: of ?? cur?.of ?? null },
    { channel: 'runtime' }
  );
}

/** Drop a status that no longer describes anything. */
export function clearStatus(kind: StatusKind, key: string): void {
  const id = statusId(kind, key);
  if (_col?.get(id)) _col.remove(id, { channel: 'runtime' });
}

/** The status collection, or null before the mesh is up. */
export function statusCollection(): Collection<StatusDoc> | null {
  return _col;
}

/** A mocap receiver's state, attached to its behavior. */
export function publishTracking(
  s: { behaviorId: string } & Record<string, unknown>
): void {
  const { behaviorId, ...fields } = s;
  publishStatus('tracking', behaviorId, fields, {
    rtype: 'behavior',
    id: behaviorId,
  });
}

/** Drop every status about document `id` (it was removed). */
export function clearStatusOf(id: string): void {
  if (!_col) return;
  for (const d of _col.all())
    if (d.of?.id === id) _col.remove(d.id, { channel: 'runtime' });
}
