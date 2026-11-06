/**
 * Local-only access guard for the HTTP API, `/mcp` and the WebSocket upgrades.
 *
 * The REST API and MCP are designed for local use (no authentication), but the
 * server listens on every interface so the bundled app can also be opened from
 * another machine when the user opts in. This guard enforces the local-only
 * default and closes the two browser-borne attacks a local server is open to:
 *
 *  - **LAN access**: requests from a non-loopback address are refused unless
 *    `VSPARK_ALLOW_LAN=1`. The Vite dev proxy connects from loopback, so dev
 *    access over LAN/Tailscale through Vite keeps working either way.
 *  - **DNS rebinding**: a hostile domain re-resolved to 127.0.0.1 arrives with
 *    its own name in `Host`. Only loopback names, IP literals and names listed
 *    in `VSPARK_ALLOWED_HOSTS` are accepted.
 *  - **Cross-site WebSocket hijacking**: a page on another site can open a
 *    socket to localhost (browsers don't apply CORS to WebSockets). Upgrades
 *    whose `Origin` is not loopback, an IP literal, the request's own host or a
 *    listed name are refused.
 */
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { Request, RequestHandler } from 'express';
import { isIP } from 'net';

function allowLan(): boolean {
  return process.env.VSPARK_ALLOW_LAN === '1';
}

function extraHosts(): string[] {
  return (process.env.VSPARK_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || a.startsWith('127.');
}

/** The browser's own address. Behind the Vite dev proxy every request arrives
 *  from loopback, so the proxy's X-Forwarded-For is used — trusted only when
 *  the connection itself is from loopback, i.e. from that proxy — and only its
 *  LAST entry: the proxy appends the address it saw, while anything before it
 *  came from the browser and can say whatever the browser likes. */
export function browserAddress(req: Request): string | undefined {
  const socket = req.socket.remoteAddress;
  const fwd = req.headers['x-forwarded-for'];
  if (isLoopbackAddress(socket) && typeof fwd === 'string' && fwd.trim())
    return fwd.split(',').at(-1)!.trim();
  return socket;
}

/** Hostname of a `Host` header or URL authority, lower-cased, without port. */
function hostnameOf(authority: string): string {
  const a = authority.trim().toLowerCase();
  if (a.startsWith('[')) return a.slice(1, a.indexOf(']')); // [::1]:3001
  const parts = a.split(':');
  // host:port → host. More than one colon is a bare IPv6 literal.
  return parts.length === 2 ? parts[0] : a;
}

function trustedHostname(name: string): boolean {
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    isIP(name) !== 0 ||
    extraHosts().includes(name)
  );
}

export function hostAllowed(hostHeader: string | undefined): boolean {
  // HTTP/1.0 clients may omit Host; they can't be a rebinding browser.
  if (!hostHeader) return true;
  return trustedHostname(hostnameOf(hostHeader));
}

export function originAllowed(
  origin: string | undefined,
  hostHeader: string | undefined
): boolean {
  if (!origin) return true; // non-browser client
  let name: string;
  try {
    name = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (trustedHostname(name)) return true;
  return !!hostHeader && name === hostnameOf(hostHeader);
}

function remoteAllowed(addr: string | undefined): boolean {
  return allowLan() || isLoopbackAddress(addr);
}

/** Express middleware: refuse non-local callers and rebinding hosts. */
export const localAccessGuard: RequestHandler = (req, res, next) => {
  if (!remoteAllowed(req.socket.remoteAddress)) {
    res.status(403).json({
      ok: false,
      error: {
        status: 403,
        message:
          'vspark only accepts local connections. Set VSPARK_ALLOW_LAN=1 to allow other machines.',
      },
    });
    return;
  }
  if (!hostAllowed(req.headers.host)) {
    res
      .status(403)
      .json({ ok: false, error: { status: 403, message: 'host not allowed' } });
    return;
  }
  next();
};

/** Upgrade gate for `/ws` and `/mesh`. Destroys the socket and returns false
 *  when the upgrade is refused. */
export function upgradeAllowed(req: IncomingMessage, socket: Duplex): boolean {
  const ok =
    remoteAllowed(req.socket.remoteAddress) &&
    hostAllowed(req.headers.host) &&
    originAllowed(req.headers.origin, req.headers.host);
  if (!ok) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
  return ok;
}
