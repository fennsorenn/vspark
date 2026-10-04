/**
 * Enrollment: how a browser gets the token its `/mesh` hello carries.
 *
 * `POST /api/mesh/enroll { label?, code? }` issues a token. A browser on this
 * machine gets one directly; any other browser must send the current pairing
 * code (printed on server start, readable by local callers from
 * `GET /api/mesh/pairing-code`). Without it the answer is 403 with
 * `code: 'PAIRING_REQUIRED'`, which the frontend turns into a prompt.
 */
import { Router, type Request } from 'express';
import {
  consumePairingCode,
  currentPairingCode,
  issueClientToken,
} from './clients.js';

const isLoopback = (addr: string | undefined): boolean => {
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || a.startsWith('127.');
};

/** The browser's own address. Behind the Vite dev proxy every request arrives
 *  from loopback, so the proxy's X-Forwarded-For is used — trusted only when
 *  the connection itself is from loopback, i.e. from that proxy — and only its
 *  LAST entry: the proxy appends the address it saw, while anything before it
 *  came from the browser and can say whatever the browser likes. */
export function browserAddress(req: Request): string | undefined {
  const socket = req.socket.remoteAddress;
  const fwd = req.headers['x-forwarded-for'];
  if (isLoopback(socket) && typeof fwd === 'string' && fwd.trim())
    return fwd.split(',').at(-1)!.trim();
  return socket;
}

export const authRoutes = Router();

authRoutes.post('/mesh/enroll', (req, res) => {
  const body = (req.body ?? {}) as { label?: unknown; code?: unknown };
  const label = typeof body.label === 'string' ? body.label : '';
  const local = isLoopback(browserAddress(req));
  if (!local && !consumePairingCode(body.code)) {
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
  if (!isLoopback(browserAddress(req))) {
    res
      .status(403)
      .json({
        ok: false,
        error: { status: 403, message: 'local callers only' },
      });
    return;
  }
  res.json({ ok: true, data: { code: currentPairingCode() } });
});
