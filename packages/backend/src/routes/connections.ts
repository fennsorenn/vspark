/**
 * Connections REST — this server's identity + the paired-contacts list backing
 * the Connections window. Pairing and live connect/disconnect (which need the
 * rendezvous + WebRTC mesh) are added in a later step; this exposes the contact
 * CRUD + identity now.
 *
 * See dev-notes/plans/multiplayer-phase5.md.
 */
import { Router } from 'express';
import { getIdentity } from '../multiplayer/identity.js';
import {
  listKnownPeers,
  getKnownPeer,
  removeKnownPeer,
  setPeerBlocked,
  setPeerDisplayName,
  hasActiveGrant,
} from '../multiplayer/peers.js';

const router: ReturnType<typeof Router> = Router();

/** This server's stable identity (peer id + public key) for display/pairing. */
router.get('/connections/identity', (_req, res) => {
  const id = getIdentity();
  res.json({ ok: true, data: id });
});

/** Paired contacts + whether each currently holds an auto-accept session grant. */
router.get('/connections/peers', (_req, res) => {
  const data = listKnownPeers().map((p) => ({
    ...p,
    sessionGranted: hasActiveGrant(p.peerId),
  }));
  res.json({ ok: true, data });
});

router.put('/connections/peers/:peerId', (req, res) => {
  if (!getKnownPeer(req.params.peerId))
    return res.status(404).json({
      ok: false,
      error: { status: 404, message: 'peer not found', code: 'NOT_FOUND' },
    });
  const { displayName, blocked } = req.body ?? {};
  if (typeof displayName === 'string')
    setPeerDisplayName(req.params.peerId, displayName);
  if (typeof blocked === 'boolean') setPeerBlocked(req.params.peerId, blocked);
  res.json({ ok: true, data: getKnownPeer(req.params.peerId) });
});

router.delete('/connections/peers/:peerId', (req, res) => {
  removeKnownPeer(req.params.peerId);
  res.json({ ok: true, data: { peerId: req.params.peerId } });
});

export default router;
