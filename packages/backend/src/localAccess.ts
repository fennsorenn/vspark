/**
 * Local-only access guard for the HTTP API, `/mcp` and the WebSocket upgrades.
 *
 * The REST API and MCP are designed for local use (no authentication), but the
 * server listens on every interface so the bundled app can also be opened from
 * another machine when the user opts in. This guard enforces the local-only
 * default and closes the two browser-borne attacks a local server is open to:
 *
 *  - **LAN access**: `VSPARK_ALLOW_LAN` lists the networks that may connect
 *    at all; everything else is refused. Unset (or empty) it is `self`: this
 *    machine's own addresses (e.g. a Docker bridge or its LAN IP), which are
 *    as local as loopback. `0` allows loopback only. The Vite dev proxy
 *    connects from loopback, so dev access through Vite works either way.
 *
 * `VSPARK_TRUSTED_NETWORKS` lists the networks whose browsers join the mesh
 * without the device code (see `trustedNetworkAddress`); unset, it is the same
 * as `VSPARK_ALLOW_LAN`. Browsers outside it join with the code.
 *
 * Both lists are comma-separated entries: `self`, `lan` (also `1` / `true` /
 * `yes`: the private and link-local ranges), `tailscale`, `any` (`*`), CIDR
 * ranges and single addresses. Loopback is always allowed and trusted.
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
import { networkInterfaces } from 'os';

/** `VSPARK_ALLOW_LAN`: who may connect. Unset or empty means `self`. */
function allowSetting(): string {
  return (process.env.VSPARK_ALLOW_LAN ?? '').trim() || 'self';
}

/** `VSPARK_TRUSTED_NETWORKS`: who skips the device code. Unset or empty means
 *  the same as `VSPARK_ALLOW_LAN`. */
function trustSetting(): string {
  return (process.env.VSPARK_TRUSTED_NETWORKS ?? '').trim() || allowSetting();
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

/** One list entry as subnets, or null when it isn't understood. (`self` is
 *  handled apart: this machine's addresses change while it runs.) */
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

interface NetworkList {
  setting: string;
  list: BlockList;
  self: boolean;
  unknown: string[];
}

const _lists = new Map<string, NetworkList>();

/** Parse a list setting (cached per value). `0` is the empty list. */
function networkList(setting: string): NetworkList {
  const cached = _lists.get(setting);
  if (cached) return cached;
  const list = new BlockList();
  let self = false;
  const unknown: string[] = [];
  if (setting !== '0')
    for (const entry of setting
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)) {
      if (entry.toLowerCase() === 'self') {
        self = true;
        continue;
      }
      const subnets = subnetsOf(entry);
      if (!subnets) unknown.push(entry);
      else
        for (const [net, prefix, fam] of subnets)
          list.addSubnet(net, prefix, fam);
    }
  const parsed = { setting, list, self, unknown };
  _lists.set(setting, parsed);
  return parsed;
}

const unmapped = (addr: string): string =>
  addr.startsWith('::ffff:') ? addr.slice(7) : addr;

const OWN_ADDRESSES_TTL_MS = 5000;
let _own: { at: number; set: Set<string> } | null = null;

/** This machine's own interface addresses, re-read every few seconds so a VPN
 *  or DHCP change is picked up and a released address is not trusted. */
function ownAddresses(): Set<string> {
  const now = Date.now();
  if (_own && now - _own.at < OWN_ADDRESSES_TTL_MS) return _own.set;
  const set = new Set<string>();
  for (const infos of Object.values(networkInterfaces()))
    for (const i of infos ?? []) set.add(i.address.toLowerCase().split('%')[0]);
  _own = { at: now, set };
  return set;
}

/** A connection from one of this machine's own addresses comes from this
 *  machine: the kernel drops packets from the network that claim one of them,
 *  and replies to such an address never leave the machine. */
export function isOwnAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return ownAddresses().has(unmapped(addr).toLowerCase());
}

/** Does `addr` fall in the list? Loopback always does. */
function inList(l: NetworkList, addr: string | undefined): boolean {
  if (isLoopbackAddress(addr)) return true;
  if (!addr) return false;
  if (l.self && isOwnAddress(addr)) return true;
  const a = unmapped(addr);
  const v = isIP(a);
  if (!v) return false;
  return l.list.check(a, v === 4 ? 'ipv4' : 'ipv6');
}

/** Ignored entries of both settings (for the startup log). */
export function unknownNetworkEntries(): { setting: string; entry: string }[] {
  const out: { setting: string; entry: string }[] = [];
  for (const entry of networkList(allowSetting()).unknown)
    out.push({ setting: 'VSPARK_ALLOW_LAN', entry });
  if ((process.env.VSPARK_TRUSTED_NETWORKS ?? '').trim())
    for (const entry of networkList(trustSetting()).unknown)
      out.push({ setting: 'VSPARK_TRUSTED_NETWORKS', entry });
  return out;
}

/** The effective settings (for the startup log). */
export function networkSettings(): { allowed: string; trusted: string } {
  return { allowed: allowSetting(), trusted: trustSetting() };
}

/** A browser at `addr` joins the mesh without the device code: this machine
 *  always, other addresses when `VSPARK_TRUSTED_NETWORKS` lists them. */
export function trustedNetworkAddress(addr: string | undefined): boolean {
  return inList(networkList(trustSetting()), addr);
}

/** A caller on this machine: loopback or one of its own addresses. */
export function isThisMachine(addr: string | undefined): boolean {
  return isLoopbackAddress(addr) || isOwnAddress(addr);
}

function extraHosts(): string[] {
  return (process.env.VSPARK_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = unmapped(addr);
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

/** May `addr` connect at all? Loopback always; else `VSPARK_ALLOW_LAN`. */
export function remoteAllowed(addr: string | undefined): boolean {
  return inList(networkList(allowSetting()), addr);
}

/** Express middleware: refuse non-local callers and rebinding hosts. */
export const localAccessGuard: RequestHandler = (req, res, next) => {
  if (!remoteAllowed(req.socket.remoteAddress)) {
    res.status(403).json({
      ok: false,
      error: {
        status: 403,
        message:
          'vspark does not accept connections from this address. List its network in VSPARK_ALLOW_LAN (e.g. self,lan) to allow it.',
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
