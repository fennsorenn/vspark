/**
 * Local-only access guard for the HTTP API, `/mcp` and the WebSocket upgrades.
 *
 * The REST API and MCP are designed for local use (no authentication), but the
 * server listens on every interface so the bundled app can also be opened from
 * another machine when the user opts in. This guard enforces the local-only
 * default and closes the two browser-borne attacks a local server is open to:
 *
 *  - **LAN access**: requests from a non-loopback address are refused unless
 *    `VSPARK_ALLOW_LAN` is set. The Vite dev proxy connects from loopback, so
 *    dev access over LAN/Tailscale through Vite keeps working either way.
 *
 * `VSPARK_ALLOW_LAN` also names the networks whose browsers join the mesh
 * without the device code (see `trustedNetworkAddress`): `1` or `lan` is the
 * local network only; a comma list may add `tailscale`, CIDR ranges, single
 * addresses or `any`. Browsers outside it still join with the code.
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
import { BlockList, isIP } from 'net';

function allowLanSetting(): string {
  return (process.env.VSPARK_ALLOW_LAN ?? '').trim();
}

/** Other machines may reach the server at all (any value but empty / `0`). */
function allowLan(): boolean {
  const v = allowLanSetting();
  return v !== '' && v !== '0';
}

type Subnet = [network: string, prefix: number, family: 'ipv4' | 'ipv6'];

/** Private and link-local ranges: the network this machine sits on. */
const LAN: Subnet[] = [
  ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
];
/** Tailscale's address ranges (CGNAT block and its IPv6 ULA prefix). */
const TAILSCALE: Subnet[] = [
  ['100.64.0.0', 10, 'ipv4'],
  ['fd7a:115c:a1e0::', 48, 'ipv6'],
];
const ANY: Subnet[] = [
  ['0.0.0.0', 0, 'ipv4'],
  ['::', 0, 'ipv6'],
];

/** One entry of `VSPARK_ALLOW_LAN`, or null when it isn't understood. */
function subnetsOf(entry: string): Subnet[] | null {
  const e = entry.toLowerCase();
  if (e === '1' || e === 'true' || e === 'yes' || e === 'lan') return LAN;
  if (e === 'tailscale') return TAILSCALE;
  if (e === 'any' || e === '*') return ANY;
  const [addr, bits, extra] = e.split('/');
  const v = isIP(addr);
  if (!v || extra !== undefined) return null;
  const max = v === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return [[addr, prefix, v === 4 ? 'ipv4' : 'ipv6']];
}

let _trusted: { setting: string; list: BlockList; unknown: string[] } | null =
  null;

function trustedNetworks(): { list: BlockList; unknown: string[] } {
  const setting = allowLanSetting();
  if (_trusted?.setting === setting) return _trusted;
  const list = new BlockList();
  const unknown: string[] = [];
  if (allowLan())
    for (const entry of setting
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)) {
      const subnets = subnetsOf(entry);
      if (!subnets) unknown.push(entry);
      else
        for (const [net, prefix, fam] of subnets)
          list.addSubnet(net, prefix, fam);
    }
  _trusted = { setting, list, unknown };
  return _trusted;
}

/** Entries of `VSPARK_ALLOW_LAN` that were ignored (for the startup log). */
export function unknownTrustedNetworkEntries(): string[] {
  return trustedNetworks().unknown;
}

/** A browser at `addr` joins the mesh without the device code: this machine
 *  always, other machines when their network is listed in `VSPARK_ALLOW_LAN`. */
export function trustedNetworkAddress(addr: string | undefined): boolean {
  if (isLoopbackAddress(addr)) return true;
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  const v = isIP(a);
  if (!v) return false;
  return trustedNetworks().list.check(a, v === 4 ? 'ipv4' : 'ipv6');
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
          'vspark only accepts local connections. Set VSPARK_ALLOW_LAN=1 (or a list of networks) to allow other machines.',
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
