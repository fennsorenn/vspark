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
import { multiplayerManager } from '../multiplayer/manager.js';
import {
  listKnownPeers,
  getKnownPeer,
  removeKnownPeer,
  setPeerBlocked,
  setPeerDisplayName,
  hasActiveGrant,
} from '../multiplayer/peers.js';

const router: ReturnType<typeof Router> = Router();

/** Whether multiplayer is enabled + the rendezvous connection status. */
router.get('/connections/status', (_req, res) => {
  res.json({ ok: true, data: multiplayerManager.status() });
});

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

// --- pairing ---------------------------------------------------------------

/** Create a one-time pairing code to share with another server. */
router.post('/connections/pair/create', async (_req, res) => {
  if (!multiplayerManager.isEnabled)
    return res.status(503).json({
      ok: false,
      error: {
        status: 503,
        message: 'multiplayer is not enabled',
        code: 'MULTIPLAYER_DISABLED',
      },
    });
  try {
    const code = await multiplayerManager.pairCreate();
    res.json({ ok: true, data: { code } });
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: {
        status: 502,
        message: e instanceof Error ? e.message : String(e),
        code: 'PAIR_FAILED',
      },
    });
  }
});

/** Join another server's pairing code; stores it as a contact. */
router.post('/connections/pair/join', async (req, res) => {
  if (!multiplayerManager.isEnabled)
    return res.status(503).json({
      ok: false,
      error: {
        status: 503,
        message: 'multiplayer is not enabled',
        code: 'MULTIPLAYER_DISABLED',
      },
    });
  const code = (req.body?.code as string)?.trim();
  if (!code)
    return res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: 'code required',
        code: 'VALIDATION_ERROR',
      },
    });
  try {
    const peer = await multiplayerManager.pairJoin(code);
    res.json({ ok: true, data: peer });
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: {
        status: 502,
        message: e instanceof Error ? e.message : String(e),
        code: 'PAIR_FAILED',
      },
    });
  }
});

export default router;
