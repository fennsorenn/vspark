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
  getProjectDisplayName,
  setProjectDisplayName,
} from '../multiplayer/peers.js';

const router: ReturnType<typeof Router> = Router();

/** Whether multiplayer is enabled + the rendezvous connection status. */
router.get('/connections/status', (_req, res) => {
  res.json({ ok: true, data: multiplayerManager.status() });
});

/** The per-project display name peers see you as. */
router.get('/connections/display-name/:projectId', (req, res) => {
  res.json({
    ok: true,
    data: { displayName: getProjectDisplayName(req.params.projectId) },
  });
});

/** Set the per-project display name + push it live to peers. */
router.put('/connections/display-name/:projectId', (req, res) => {
  const name = String(req.body?.name ?? '').slice(0, 64);
  setProjectDisplayName(req.params.projectId, name);
  if (multiplayerManager.isEnabled) multiplayerManager.setDisplayName(name);
  res.json({ ok: true, data: { displayName: name } });
});

/** This server's stable identity (peer id + public key) for display/pairing. */
router.get('/connections/identity', (_req, res) => {
  const id = getIdentity();
  res.json({ ok: true, data: id });
});

/** Paired contacts + their session-grant + live connection state. */
router.get('/connections/peers', (_req, res) => {
  const data = listKnownPeers().map((p) => ({
    ...p,
    sessionGranted: hasActiveGrant(p.peerId),
    connected: multiplayerManager.isConnected(p.peerId),
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
  // When multiplayer is live, route through the manager so it also tears down
  // any connection, notifies the peer (mutual unpair), and pushes the change to
  // our clients. Fall back to a bare DB removal when multiplayer is disabled.
  if (multiplayerManager.isEnabled)
    multiplayerManager.removePeer(req.params.peerId);
  else removeKnownPeer(req.params.peerId);
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

// --- connect / disconnect / accept / reject -------------------------------

const guarded = (
  fn: (peerId: string) => Promise<unknown> | unknown
): import('express').RequestHandler => {
  return async (req, res) => {
    if (!multiplayerManager.isEnabled)
      return res.status(503).json({
        ok: false,
        error: {
          status: 503,
          message: 'multiplayer is not enabled',
          code: 'MULTIPLAYER_DISABLED',
        },
      });
    const peerId = String(req.params.peerId);
    try {
      await fn(peerId);
      res.json({ ok: true, data: { peerId } });
    } catch (e) {
      res.status(502).json({
        ok: false,
        error: {
          status: 502,
          message: e instanceof Error ? e.message : String(e),
          code: 'CONNECT_FAILED',
        },
      });
    }
  };
};

router.post(
  '/connections/peers/:peerId/connect',
  guarded((id) => multiplayerManager.connect(id))
);
router.post(
  '/connections/peers/:peerId/disconnect',
  guarded((id) => multiplayerManager.disconnect(id))
);
router.post(
  '/connections/peers/:peerId/accept',
  guarded((id) => multiplayerManager.accept(id))
);
router.post(
  '/connections/peers/:peerId/reject',
  guarded((id) => multiplayerManager.reject(id))
);

// --- sharing ---------------------------------------------------------------

/** Grantees of an object (peer ids + maybe '*') — for the Share-with menu. */
router.get('/connections/objects/:objectId/grantees', (req, res) => {
  res.json({
    ok: true,
    data: multiplayerManager.grantees(req.params.objectId),
  });
});

/** Grant a peer (or '*') access to an object. */
router.post('/connections/objects/:objectId/share', (req, res) => {
  if (!multiplayerManager.isEnabled)
    return res.status(503).json({
      ok: false,
      error: {
        status: 503,
        message: 'multiplayer is not enabled',
        code: 'MULTIPLAYER_DISABLED',
      },
    });
  const granteePeerId = String(req.body?.granteePeerId ?? '');
  const shareKind = req.body?.shareKind === 'scene' ? 'scene' : 'object';
  const canWrite = req.body?.canWrite === true;
  if (!granteePeerId)
    return res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: 'granteePeerId required',
        code: 'VALIDATION_ERROR',
      },
    });
  multiplayerManager.share(
    req.params.objectId,
    granteePeerId,
    shareKind,
    canWrite
  );
  res.json({
    ok: true,
    data: { grantees: multiplayerManager.grantees(req.params.objectId) },
  });
});

/** Revoke a grant. */
router.post('/connections/objects/:objectId/unshare', (req, res) => {
  const granteePeerId = String(req.body?.granteePeerId ?? '');
  multiplayerManager.unshare(req.params.objectId, granteePeerId);
  res.json({
    ok: true,
    data: { grantees: multiplayerManager.grantees(req.params.objectId) },
  });
});

/** Receiver: subscribe / unsubscribe to a peer's shared object. */
router.post('/connections/peers/:peerId/subscribe', (req, res) => {
  const objectId = String(req.body?.objectId ?? '');
  if (objectId) multiplayerManager.subscribeShared(req.params.peerId, objectId);
  res.json({ ok: true, data: { peerId: req.params.peerId, objectId } });
});
router.post('/connections/peers/:peerId/unsubscribe', (req, res) => {
  const objectId = String(req.body?.objectId ?? '');
  if (objectId)
    multiplayerManager.unsubscribeShared(req.params.peerId, objectId);
  res.json({ ok: true, data: { peerId: req.params.peerId, objectId } });
});

export default router;
