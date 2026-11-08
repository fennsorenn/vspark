/**
 * Enrollment: how a browser gets the token its `/mesh` hello carries.
 *
 * `POST /api/mesh/enroll { label?, code? }` issues a token. A browser on this
 * machine, or on a network `VSPARK_TRUSTED_NETWORKS` trusts (by default the
 * same as `VSPARK_ALLOW_LAN`), gets one directly; any other browser must send
 * the current pairing code (printed on server start, readable by this machine
 * from
 * `GET /api/mesh/pairing-code`). Without it the answer is 403 with
 * `code: 'PAIRING_REQUIRED'`, which the frontend turns into a prompt.
 */
import { Router } from 'express';
import {
  browserAddress,
  isThisMachine,
  trustedNetworkAddress,
} from '../localAccess.js';
import {
  consumePairingCode,
  currentPairingCode,
  issueClientToken,
} from './clients.js';

export const authRoutes = Router();

authRoutes.post('/mesh/enroll', (req, res) => {
  const body = (req.body ?? {}) as { label?: unknown; code?: unknown };
  const label = typeof body.label === 'string' ? body.label : '';
  const trusted = trustedNetworkAddress(browserAddress(req));
  if (!trusted && !consumePairingCode(body.code)) {
    res.status(403).json({
      ok: false,
      error: {
        status: 403,
        code: 'PAIRING_REQUIRED',
        message:
          'This browser is not on the vspark machine: enter the pairing code shown in vspark.',
      },
    });
    return;
  }
  res.json({ ok: true, data: issueClientToken(label) });
});

authRoutes.get('/mesh/pairing-code', (req, res) => {
  if (!isThisMachine(browserAddress(req))) {
    res.status(403).json({
      ok: false,
      error: { status: 403, message: 'local callers only' },
    });
    return;
  }
  res.json({ ok: true, data: { code: currentPairingCode() } });
});
