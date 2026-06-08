/**
 * Data access for paired contacts (`known_peers`) and the persisted accept
 * policy (`session_grants`).
 *
 * - A contact is created at pairing (mutual pubkey exchange) and identified by
 *   its pubkey fingerprint, stable across IP changes.
 * - A session grant means "auto-accept this peer's incoming connections until
 *   `expires_at`". Persisted so a crash/restart reconnects friction-free; it is
 *   deleted on manual disconnect.
 *
 * See dev-notes/plans/multiplayer-phase5.md.
 */
import { getDb } from '../db/index.js';

export interface KnownPeer {
  peerId: string;
  publicKey: string;
  displayName: string;
  pairedAt: string;
  lastSeen: string | null;
  blocked: boolean;
}

interface KnownPeerRow {
  peer_id: string;
  public_key: string;
  display_name: string;
  paired_at: string;
  last_seen: string | null;
  blocked: number;
}

function mapPeer(r: KnownPeerRow): KnownPeer {
  return {
    peerId: r.peer_id,
    publicKey: r.public_key,
    displayName: r.display_name,
    pairedAt: r.paired_at,
    lastSeen: r.last_seen,
    blocked: r.blocked === 1,
  };
}

export function listKnownPeers(): KnownPeer[] {
  return (
    getDb()
      .prepare('SELECT * FROM known_peers ORDER BY display_name, peer_id')
      .all() as unknown as KnownPeerRow[]
  ).map(mapPeer);
}

export function getKnownPeer(peerId: string): KnownPeer | undefined {
  const r = getDb()
    .prepare('SELECT * FROM known_peers WHERE peer_id = ?')
    .get(peerId) as unknown as KnownPeerRow | undefined;
  return r ? mapPeer(r) : undefined;
}

/** Insert or update a contact (used at pairing). */
export function upsertKnownPeer(p: {
  peerId: string;
  publicKey: string;
  displayName?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO known_peers (peer_id, public_key, display_name)
       VALUES (?, ?, ?)
       ON CONFLICT(peer_id) DO UPDATE SET
         public_key = excluded.public_key,
         display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE known_peers.display_name END`
    )
    .run(p.peerId, p.publicKey, p.displayName ?? '');
}

export function setPeerDisplayName(peerId: string, displayName: string): void {
  getDb()
    .prepare('UPDATE known_peers SET display_name = ? WHERE peer_id = ?')
    .run(displayName, peerId);
}

export function setPeerBlocked(peerId: string, blocked: boolean): void {
  getDb()
    .prepare('UPDATE known_peers SET blocked = ? WHERE peer_id = ?')
    .run(blocked ? 1 : 0, peerId);
  if (blocked) revokeSessionGrant(peerId);
}

/** Remove a contact entirely (cascades the session grant). */
export function removeKnownPeer(peerId: string): void {
  getDb().prepare('DELETE FROM known_peers WHERE peer_id = ?').run(peerId);
}

export function touchLastSeen(peerId: string): void {
  getDb()
    .prepare(
      "UPDATE known_peers SET last_seen = datetime('now') WHERE peer_id = ?"
    )
    .run(peerId);
}

// --- Per-project display name -----------------------------------------------

/** The name peers see you as while this project is active (empty = unset). */
export function getProjectDisplayName(projectId: string): string {
  const r = getDb()
    .prepare('SELECT mp_display_name FROM projects WHERE id = ?')
    .get(projectId) as { mp_display_name: string } | undefined;
  return r?.mp_display_name ?? '';
}

export function setProjectDisplayName(projectId: string, name: string): void {
  getDb()
    .prepare('UPDATE projects SET mp_display_name = ? WHERE id = ?')
    .run(name, projectId);
}

// --- Session grants (persisted accept policy) -------------------------------

const DEFAULT_GRANT_TTL_MS = 12 * 60 * 60 * 1000; // ~12h

/** Grant auto-accept to a peer for `ttlMs` (default ~12h). */
export function grantSession(
  peerId: string,
  ttlMs = DEFAULT_GRANT_TTL_MS
): void {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  getDb()
    .prepare(
      `INSERT INTO session_grants (peer_id, expires_at) VALUES (?, ?)
       ON CONFLICT(peer_id) DO UPDATE SET expires_at = excluded.expires_at`
    )
    .run(peerId, expiresAt);
}

/** True if the peer currently has a non-expired grant (and isn't blocked). */
export function hasActiveGrant(peerId: string): boolean {
  const r = getDb()
    .prepare('SELECT expires_at FROM session_grants WHERE peer_id = ?')
    .get(peerId) as { expires_at: string } | undefined;
  if (!r) return false;
  if (Date.parse(r.expires_at) <= Date.now()) {
    revokeSessionGrant(peerId);
    return false;
  }
  const peer = getKnownPeer(peerId);
  return !!peer && !peer.blocked;
}

/** Drop a grant — called on manual disconnect. */
export function revokeSessionGrant(peerId: string): void {
  getDb().prepare('DELETE FROM session_grants WHERE peer_id = ?').run(peerId);
}

/** Housekeeping: clear expired grants (call on boot / periodically). */
export function pruneExpiredGrants(): void {
  getDb()
    .prepare("DELETE FROM session_grants WHERE expires_at <= datetime('now')")
    .run();
}
